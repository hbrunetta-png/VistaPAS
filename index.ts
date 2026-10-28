// =====================================================================
// VistaPAS · Edge Function "arca-padron"
// Busca los datos de una persona o empresa en el padrón de ARCA (servicio ws_sr_padron_a13)
// a partir de su DNI o CUIT. Solo consulta: no factura ni modifica nada.
//
// Cómo funciona:
//   1. El CRM llama a esta función con el DNI o CUIT (y la sesión del productor).
//   2. La función se autentica en ARCA (WSAA) con el certificado de VistaPAS y guarda el
//      "ticket de acceso" 12 horas en la tabla arca_cache (ARCA no da otro mientras ese siga vigente).
//   3. Con un DNI, pide a ARCA la lista de CUIT/CUIL de ese documento (getIdPersonaListByDocumento);
//      si ARCA no devuelve nada, prueba los CUIL posibles (20, 27, 23 y 24). Luego trae cada persona (getPersona).
//   4. Devuelve los datos normalizados. Guarda cada resultado 30 días para no repetir consultas.
//
// Variables (Supabase → Edge Functions → Secrets):
//   ARCA_ENV   homo (pruebas) | prod (producción)
//   ARCA_CUIT  CUIT de VistaPAS (el que tiene el certificado y el servicio asociado)
//   ARCA_CERT  certificado en formato PEM (-----BEGIN CERTIFICATE----- ...)
//   ARCA_KEY   clave privada en formato PEM (-----BEGIN PRIVATE KEY----- o RSA PRIVATE KEY)
//   ARCA_LIMITE_HORA  (opcional) consultas por productor por hora. Por defecto 60.
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los pone Supabase automáticamente.
// =====================================================================
import forge from "npm:node-forge@1.3.1";
import { createClient } from "npm:@supabase/supabase-js@2";

const ENV = (Deno.env.get("ARCA_ENV") ?? "homo") === "prod" ? "prod" : "homo";
const URLS = {
  homo: { wsaa: "https://wsaahomo.afip.gov.ar/ws/services/LoginCms", a13: "https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA13" },
  prod: { wsaa: "https://wsaa.afip.gov.ar/ws/services/LoginCms", a13: "https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA13" },
}[ENV];
// Solo para pruebas locales: permite apuntar a un simulador de ARCA.
if (Deno.env.get("ARCA_URL_WSAA")) URLS.wsaa = Deno.env.get("ARCA_URL_WSAA")!;
if (Deno.env.get("ARCA_URL_A13")) URLS.a13 = Deno.env.get("ARCA_URL_A13")!;
const SERVICE = "ws_sr_padron_a13";
const LIMITE = Number(Deno.env.get("ARCA_LIMITE_HORA") ?? 60);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ---------- utilidades XML (las respuestas de ARCA son SOAP simples) ----------
export const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const tagRe = (name: string) => new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "g");
export function tags(xml: string, name: string): string[] { return [...xml.matchAll(tagRe(name))].map((m) => m[1]); }
export function tag(xml: string, name: string): string { return tags(xml, name)[0] ?? ""; }
const txt = (xml: string, name: string) => unescapeXml(tag(xml, name)).trim();

// ---------- CUIT / CUIL ----------
export function cuitValido(c: string): boolean {
  if (!/^\d{11}$/.test(c)) return false;
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const s = w.reduce((a, x, i) => a + x * Number(c[i]), 0);
  let d = 11 - (s % 11); if (d === 11) d = 0; if (d === 10) return false;
  return d === Number(c[10]);
}
export function cuilesPosibles(dni: string): string[] {
  const doc = dni.padStart(8, "0"), out: string[] = [];
  for (const pre of ["20", "27", "23", "24"]) {
    for (let dv = 0; dv <= 9; dv++) { const c = pre + doc + dv; if (cuitValido(c)) { out.push(c); break; } }
  }
  return out;
}

// ---------- WSAA: ticket de acceso ----------
export function buildTRA(service: string, now = new Date()): string {
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return `<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>${Math.floor(now.getTime() / 1000)}</uniqueId>` +
    `<generationTime>${iso(new Date(now.getTime() - 10 * 60e3))}</generationTime><expirationTime>${iso(new Date(now.getTime() + 10 * 60e3))}</expirationTime></header>` +
    `<service>${service}</service></loginTicketRequest>`;
}
export function signCMS(tra: string, certPem: string, keyPem: string): string {
  const cert = forge.pki.certificateFromPem(certPem), key = forge.pki.privateKeyFromPem(keyPem);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, "utf8");
  p7.addCertificate(cert);
  p7.addSigner({
    key, certificate: cert, digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign();
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}
const soap = (ns: string, body: string) => `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:x="${ns}"><soapenv:Header/><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
async function post(url: string, xml: string): Promise<string> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '""' }, body: xml, signal: AbortSignal.timeout(20000) });
  const t = await r.text();
  if (!r.ok && !/Fault/i.test(t)) throw new Error(`ARCA respondió ${r.status}`);
  return t;
}
export class ArcaFault extends Error { constructor(public code: string, msg: string) { super(msg); } }
function fault(xml: string) {
  if (!/Fault/.test(xml)) return;
  const msg = txt(xml, "faultstring") || "Error de ARCA";
  throw new ArcaFault(txt(xml, "faultcode"), msg);
}
type TA = { token: string; sign: string; expira: string };
export function parseLogin(xml: string): TA {
  fault(xml);
  const inner = unescapeXml(tag(xml, "loginCmsReturn"));
  const token = txt(inner, "token"), sign = txt(inner, "sign"), expira = txt(inner, "expirationTime");
  if (!token || !sign) throw new Error("ARCA no devolvió el ticket de acceso");
  return { token, sign, expira };
}

// ---------- Padrón A13 ----------
const NS13 = "http://a13.soap.ws.server.puc.sr/";
export function parseIdList(xml: string): string[] {
  if (/Fault/.test(xml)) { const m = txt(xml, "faultstring"); if (/no existe|no se encontr|sin resultados/i.test(m)) return []; fault(xml); }
  return tags(xml, "idPersona").map((x) => x.trim()).filter((x) => /^\d{11}$/.test(x));
}
const titulo = (s: string) => s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase());
export type Persona = { cuit: string; tipo: "fisica" | "juridica"; nombre: string; razonSocial: string; documento: string; nacimiento: string; domicilio: string; localidad: string; provincia: string; cp: string; actividad: string; estado: string };
export function parsePersona(xml: string): Persona | null {
  if (/Fault/.test(xml)) { const m = txt(xml, "faultstring"); if (/no existe|no se encontr|inexistente/i.test(m)) return null; fault(xml); }
  const p = tag(xml, "persona"); if (!p) return null;
  const doms = tags(p, "domicilio");
  const sinDom = p.replace(tagRe("domicilio"), "").replace(tagRe("actividad"), "").replace(tagRe("impuesto"), "").replace(tagRe("regimen"), "").replace(tagRe("categoria"), "");
  const d = doms.find((x) => /FISCAL/i.test(txt(x, "tipoDomicilio"))) ?? doms.find((x) => /REAL|LEGAL/i.test(txt(x, "tipoDomicilio"))) ?? doms[0] ?? "";
  const tipo = /JURIDICA/i.test(txt(sinDom, "tipoPersona")) ? "juridica" : "fisica";
  const nombre = tipo === "fisica" ? titulo([txt(sinDom, "nombre"), txt(sinDom, "apellido")].filter(Boolean).join(" ")) : "";
  const razonSocial = txt(sinDom, "razonSocial");
  const loc = titulo(txt(d, "localidad")), prov = titulo(txt(d, "descripcionProvincia")), dir = titulo(txt(d, "direccion"));
  return {
    cuit: txt(sinDom, "idPersona"), tipo, nombre: nombre || razonSocial, razonSocial,
    documento: txt(sinDom, "numeroDocumento"), nacimiento: txt(sinDom, "fechaNacimiento").slice(0, 10),
    domicilio: [dir, loc, prov].filter(Boolean).join(", "), localidad: loc, provincia: prov, cp: txt(d, "codigoPostal"),
    actividad: txt(sinDom, "descripcionActividadPrincipal"), estado: txt(sinDom, "estadoClave"),
  };
}

// ---------- servidor ----------
const admin = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
async function cacheGet(db: ReturnType<typeof admin>, key: string) {
  const { data } = await db.from("arca_cache").select("value, expires_at").eq("key", key).maybeSingle();
  return data && new Date(data.expires_at) > new Date() ? data.value : null;
}
async function cacheSet(db: ReturnType<typeof admin>, key: string, value: unknown, ms: number) {
  await db.from("arca_cache").upsert({ key, value, expires_at: new Date(Date.now() + ms).toISOString() });
}
async function getTA(db: ReturnType<typeof admin>): Promise<TA> {
  const k = "ta:" + ENV, c = await cacheGet(db, k) as TA | null;
  if (c && new Date(c.expira).getTime() - Date.now() > 5 * 60e3) return c;
  const cms = signCMS(buildTRA(SERVICE), Deno.env.get("ARCA_CERT")!, Deno.env.get("ARCA_KEY")!);
  const xml = await post(URLS.wsaa, soap("http://wsaa.view.sua.dvadac.desein.afip.gov", `<x:loginCms><x:in0>${cms}</x:in0></x:loginCms>`));
  try {
    const ta = parseLogin(xml);
    await cacheSet(db, k, ta, new Date(ta.expira).getTime() - Date.now());
    return ta;
  } catch (e) {
    if (e instanceof ArcaFault && /alreadyAuthenticated|TA valido/i.test(e.code + e.message)) throw new Error("ARCA todavía tiene vigente un ticket anterior que se perdió. Se libera solo en unos minutos (como máximo 12 horas).");
    throw e;
  }
}
async function a13(op: "getPersona" | "getIdPersonaListByDocumento", ta: TA, param: string, val: string) {
  const body = `<x:${op}><token>${escapeXml(ta.token)}</token><sign>${escapeXml(ta.sign)}</sign><cuitRepresentada>${Deno.env.get("ARCA_CUIT")}</cuitRepresentada><${param}>${val}</${param}></x:${op}>`;
  return await post(URLS.a13, soap(NS13, body));
}
async function persona(db: ReturnType<typeof admin>, ta: TA, cuit: string): Promise<Persona | null> {
  const k = "p:" + cuit, c = await cacheGet(db, k);
  if (c) return (c as { p: Persona | null }).p;
  const p = parsePersona(await a13("getPersona", ta, "idPersona", cuit));
  await cacheSet(db, k, { p }, (p ? 30 : 2) * 864e5);
  return p;
}

if (import.meta.main) Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Usá POST" }, 405);
  try {
    const db = admin();
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user) return json({ error: "Tu sesión venció. Ingresá de nuevo." }, 401);
    for (const v of ["ARCA_CUIT", "ARCA_CERT", "ARCA_KEY"]) if (!Deno.env.get(v)) return json({ error: "La búsqueda en ARCA todavía no está configurada (faltan los datos del certificado)." }, 503);

    const body = await req.json().catch(() => ({}));
    const ta = await getTA(db);
    if (body.accion === "estado") {
      const x = await post(URLS.a13, soap(NS13, "<x:dummy/>"));
      return json({ ambiente: ENV, appserver: txt(x, "appserver"), dbserver: txt(x, "dbserver"), authserver: txt(x, "authserver") });
    }
    const doc = String(body.doc ?? "").replace(/\D/g, "");
    if (!/^\d{7,8}$/.test(doc) && !/^\d{11}$/.test(doc)) return json({ error: "Escribí un DNI (7 u 8 números) o un CUIT (11 números)." }, 400);

    // límite por productor y por hora
    const rk = `rl:${u.user.id}:${new Date().toISOString().slice(0, 13)}`, n = Number((await cacheGet(db, rk)) ?? 0);
    if (n >= LIMITE) return json({ error: "Llegaste al límite de consultas por hora. Probá de nuevo en un rato." }, 429);
    await cacheSet(db, rk, n + 1, 3600e3);

    let cuits: string[];
    if (doc.length === 11) cuits = [doc];
    else {
      cuits = parseIdList(await a13("getIdPersonaListByDocumento", ta, "documento", doc));
      if (!cuits.length) cuits = cuilesPosibles(doc);
    }
    const res: Persona[] = [];
    for (const c of [...new Set(cuits)].slice(0, 6)) { const p = await persona(db, ta, c); if (p) res.push(p); }
    return json({ ambiente: ENV, resultados: res });
  } catch (e) {
    console.error(e);
    const m = e instanceof Error ? e.message : String(e);
    return json({ error: /timed? ?out|abort/i.test(m) ? "ARCA no respondió a tiempo. Probá de nuevo en unos minutos." : "No se pudo consultar ARCA: " + m }, 502);
  }
});

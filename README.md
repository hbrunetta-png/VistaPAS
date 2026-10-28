# VistaPAS · versión con cuentas

Con esta versión, cada productor crea su cuenta con email y contraseña. Sus datos se guardan en la nube y los ve desde cualquier computadora o celular. Cada cuenta es de una sola persona: está pensada para el productor que trabaja solo.

## Qué hay en esta carpeta

| Archivo | Para qué sirve |
|---|---|
| `index.html` | La aplicación completa: una sola página, sin instalar nada. |
| `supabase/esquema.sql` | Crea en Supabase las tablas, la seguridad y el espacio para archivos. |
| `supabase/functions/arca-padron/` | Función del servidor que busca los datos de un cliente en el padrón de ARCA. |
| `LEEME.md` | Esta guía. |
| `iconos/` | El isotipo de VistaPAS en PNG con fondo transparente (512, 192 y 32 px), para el dominio, redes o una app. La página ya lo trae incorporado. |

## Cómo funciona

- **Hosting** (Cloudflare Pages o Hostinger): sirve el archivo `index.html`. No hace falta un servidor propio.
- **Supabase** se ocupa de tres cosas:
  - **Cuentas:** registro, ingreso, confirmación por email y recuperación de contraseña.
  - **Base de datos:** guarda los datos de cada productor.
  - **Archivos:** documentos del legajo, PDF de cotizaciones y liquidaciones, imágenes de plantillas.
- **Seguridad:** cada productor solo puede leer y escribir sus propios datos. Lo controla la base misma con *Row Level Security* (seguridad por fila), no la página, así que nadie puede ver datos de otra cuenta aunque modifique la aplicación.
- **Sin conexión:** si se corta internet, los cambios quedan en cola en el dispositivo y se suben solos al volver. Al volver a la pestaña, la aplicación trae lo que se cambió desde otro dispositivo.
- **Modo local:** si `index.html` no tiene configurado Supabase, funciona como hasta ahora, con los datos en el navegador. Así funciona la versión de prueba publicada en Claude.

## Puesta en marcha (unos 30 minutos)

### 1. Crear el proyecto en Supabase

1. Entrá a <https://supabase.com>, creá una cuenta y después **New project**.
2. Elegí la región **South America (São Paulo)**, que es la más cercana a Argentina.
3. Guardá la contraseña de la base de datos en un lugar seguro.

### 2. Cargar el esquema

1. En el proyecto, andá a **SQL Editor → New query**.
2. Pegá todo el contenido de `supabase/esquema.sql` y tocá **Run**.
3. Se crean las tablas `accounts` y `records`, las reglas de seguridad, la cuenta automática con 30 días de prueba y el bucket privado `archivos`.

### 3. Configurar el ingreso

En **Authentication**:

- **Sign In / Providers → Email:** activado, con **Confirm email** prendido.
- **Contraseñas:** en la misma configuración de Email, largo mínimo de 8 caracteres.
- **URL Configuration:**
  - **Site URL:** la dirección final, por ejemplo `https://app.micarterapas.com.ar`.
  - **Redirect URLs:** agregá esa misma dirección. Mientras pruebes, agregá también la de Cloudflare (`https://xxxx.pages.dev`).
- **Emails:** traducí al español los textos de *Confirm signup* y *Reset password*.
- **SMTP** (importante antes de lanzar): el envío de emails que trae Supabase es solo para pruebas y tiene un límite muy bajo. Configurá un servicio propio en la sección de SMTP de **Authentication → Emails**. Sirven Resend, Brevo o el correo de tu dominio en Hostinger.

### 4. Conectar la aplicación

1. En Supabase, andá a **Project Settings → API** y copiá dos datos:
   - la **Project URL**;
   - la clave **anon / publishable**. Es pública y está bien que viaje en la página: la seguridad la da la base. **Nunca** uses la clave `service_role` en la página.
2. Abrí `index.html` con un editor de texto y buscá `MICARTERA_CONFIG`.
3. Completá los datos:

```js
window.MICARTERA_CONFIG = window.MICARTERA_CONFIG || {
  supabaseUrl: "https://TU-PROYECTO.supabase.co",
  supabaseAnonKey: "TU-CLAVE-ANON",
  terminosUrl: "https://micarterapas.com.ar/terminos",     // opcional: link en el registro
  privacidadUrl: "https://micarterapas.com.ar/privacidad"  // opcional
};
```

### 5. Publicar

Hay dos opciones.

**Opción A: Cloudflare Pages (gratis)**
1. Entrá a Cloudflare y andá a **Workers & Pages → Create → Pages → Upload assets**.
2. Arrastrá la carpeta con `index.html` y tocá **Deploy**. Te da una dirección `xxxx.pages.dev`.
3. Para usar tu dominio, andá a **Custom domains** y agregalo. El HTTPS queda activado solo.

**Opción B: Hostinger**
1. Entrá a **hPanel → Archivos → Administrador de archivos**.
2. Subí `index.html` a `public_html` (o a la carpeta de un subdominio, por ejemplo `app`).
3. Activá el SSL gratuito del dominio.

Cuando la dirección final esté funcionando, cargala en el paso 3 como Site URL y como Redirect URL.

### 6. Probar antes de abrirlo al público

- [ ] Crear una cuenta, recibir el email de confirmación, tocar el link y entrar.
- [ ] Cargar un cliente, una póliza y un documento del legajo.
- [ ] Entrar con la misma cuenta desde otro dispositivo y ver lo mismo.
- [ ] Cortar internet, hacer un cambio, volver a conectarse y verificar que se suba.
- [ ] Usar "Olvidé mi contraseña", recibir el email y elegir una contraseña nueva.
- [ ] Crear una segunda cuenta y verificar que no ve nada de la primera.
- [ ] Probar "Eliminar mi cuenta" con una cuenta de prueba.

## Búsqueda de clientes en ARCA (opcional)

En la carga o edición de un cliente hay un botón **Buscar en ARCA**. El productor escribe el DNI (o el CUIT) y el CRM trae del padrón de ARCA el nombre o la razón social, el CUIL o CUIT, el domicilio fiscal y, cuando está disponible, la fecha de nacimiento y la actividad. Si un DNI tiene más de un CUIT, se muestran las opciones para elegir. ARCA no publica teléfonos ni emails.

- **Quién la hace:** la consulta la hace la Edge Function `supabase/functions/arca-padron`, con el certificado de VistaPAS. El productor no tiene que hacer ningún trámite.
- **Qué se guarda:** el ticket de acceso de ARCA se guarda 12 horas y cada resultado, 30 días, en la tabla `arca_cache`. Así no se repiten consultas.
- **Límite:** hay un tope de 60 consultas por hora por productor, que se cambia con `ARCA_LIMITE_HORA`.
- **Sin configurar:** mientras la función no tenga el certificado cargado, el botón muestra que todavía no está configurada.

### Trámite en ARCA (una sola vez, con la clave fiscal del CUIT de VistaPAS)

Conviene hacerlo primero en **homologación** (el ambiente de prueba de ARCA) y después en **producción**. Cada ambiente tiene su propio certificado.

1. **Generar la clave privada y el pedido de certificado (CSR)** en una computadora con OpenSSL. Guardá la clave privada en un lugar seguro y no la compartas.
   ```
   openssl genrsa -out vistapas.key 2048
   openssl req -new -key vistapas.key -subj "/C=AR/O=VistaPAS/CN=vistapas/serialNumber=CUIT 20XXXXXXXXX" -out vistapas.csr
   ```
   (Reemplazá `20XXXXXXXXX` por el CUIT de VistaPAS, sin guiones.)
2. **Homologación:**
   - En ARCA, con clave fiscal, adherí el servicio **WSASS - Autogestión Certificados Homologación**.
   - Creá un certificado pegando el contenido de `vistapas.csr` y descargá el certificado que te da.
   - En el mismo WSASS, creá la **autorización** para el servicio `ws_sr_padron_a13` (Consulta a Padrón Alcance 13).
3. **Producción:**
   - Adherí el servicio **Administración de Certificados Digitales**, creá un alias, subí el mismo `vistapas.csr` (o uno nuevo) y descargá el certificado.
   - Después, en **Administrador de Relaciones de Clave Fiscal → Nueva relación**, buscá el servicio de padrón **Alcance 13** (`ws_sr_padron_a13`). Como representante, elegí el alias del certificado y confirmá.
4. **Cargar los datos en Supabase.** Ejecutá con la [CLI de Supabase](https://supabase.com/docs/guides/cli):
   ```
   supabase secrets set ARCA_ENV=homo ARCA_CUIT=20XXXXXXXXX
   supabase secrets set ARCA_CERT="$(cat certificado.pem)" ARCA_KEY="$(cat vistapas.key)"
   supabase functions deploy arca-padron
   ```
   Cuando funcione en homologación, cambiá a `ARCA_ENV=prod` y cargá el certificado de producción.
5. **Probar.** Buscá un DNI conocido desde la ficha de un cliente. Mientras esté en homologación, los resultados muestran la etiqueta "Ambiente de prueba".

**Nota técnica:** los nombres de los métodos y campos de ARCA (`getIdPersonaListByDocumento`, `getPersona`, `domicilio`, `tipoDomicilio`, etc.) siguen la especificación del servicio. La función se probó con un simulador; en homologación, confirmá contra el WSDL real que la respuesta trae esos campos. Si algo difiere, solo hay que ajustar `parsePersona` en `index.ts`.

## Planes y cobro

- **Prueba:** cada cuenta nueva arranca con `plan = 'prueba'` y 30 días de prueba (`trial_until`). El productor lo ve en **Configuraciones → Tu cuenta**.
- **Quién cambia el plan:** solo vos, como administrador, desde **Table Editor → accounts** o con las consultas que están al final de `esquema.sql`. El usuario no tiene permiso para cambiárselo.
- **Al terminar la prueba:** por ahora la aplicación no bloquea nada, solo lo muestra.
- **Cobro automático (próximo paso):** se puede sumar una suscripción de Mercado Pago. Mercado Pago avisa cada pago a una Edge Function de Supabase, y esa función cambia `plan` a `activo` o `suspendido`. Recién ahí conviene decidir qué se bloquea cuando no hay pago; por ejemplo, dejar ver los datos pero no cargar nuevos.

## Costos de referencia

Verificá los precios vigentes en las páginas de cada servicio.

- **Cloudflare Pages:** el plan gratuito alcanza para esta aplicación.
- **Supabase:** el plan gratuito sirve para probar, pero tiene límites y pausa los proyectos sin actividad. Para clientes reales usá el plan **Pro**, que es pago por mes e incluye copias de seguridad diarias.
- **Email (SMTP):** los servicios de envío transaccional suelen tener un nivel gratuito suficiente para confirmaciones y recuperaciones de contraseña.
- **Dominio:** se compra aparte, en Hostinger, NIC Argentina para `.com.ar` o Cloudflare.

## Datos personales y legales

- Vas a guardar datos personales de los clientes de cada productor. Revisá con un abogado lo que pide la Ley 25.326 de Protección de Datos Personales, por ejemplo la inscripción de la base ante la Agencia de Acceso a la Información Pública (AAIP).
- Hacen falta los **términos de uso** y la **política de privacidad**. El registro ya tiene la casilla para aceptarlos y los links se configuran en `MICARTERA_CONFIG`.

## Cómo se guardan los datos (para quien mantenga el sistema)

- **`accounts`:** una fila por productor. `doc` guarda su configuración, sus grupos familiares y los avisos resueltos.
- **`records`:** una fila por registro.
  - `coll` dice de qué colección es: `clients`, `policies`, `claims`, `opps`, `tasks`, `acts`, `cias`, `prods`, `cobros`, `liqs`, `docs`, `tpls`, `wtpls`, `charts` o `trash`.
  - `data` tiene el registro completo en JSON.
  - `deleted` marca las bajas.
  - La descripción de los campos de cada colección se descarga desde la aplicación, en **Configuraciones → Administración de datos → Esquema de datos**.
- **Archivos:** van en el bucket `archivos`, con la ruta `<id del usuario>/<id del archivo>`. Su nombre y tipo se guardan en `records` con `coll = '_files'`.
- **Reportes en SQL:** las vistas `v_clientes` y `v_polizas` muestran los datos en columnas, sin tocar el JSON.
- **Sincronización:**
  - Cada cambio se manda como alta o actualización (*upsert*) por registro, o como baja lógica.
  - Si dos dispositivos cambian el mismo registro, gana el último cambio.
  - Para un productor que trabaja solo, alcanza.

### Límites conocidos de esta versión

- **Archivos:** al ingresar se descargan todos. Para quien tenga muchos (cientos de MB) convendrá descargarlos recién cuando se abren.
- **Sesiones:** no hay ingreso con Google ni verificación en dos pasos. Supabase los soporta y se pueden agregar.

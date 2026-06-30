/**
 * generar-estrategia.js
 * POST /.netlify/functions/generar-estrategia
 *
 * 1. Recibe los datos del formulario (JSON)
 * 2. Hace fetch del sitio web del cliente (si hay URL)
 * 3. Llama a Claude API con visión (screenshot) + texto
 * 4. Genera documento HTML de la estrategia
 * 5. Hace POST a Make.com con el HTML + email
 * 6. Marca el token como 'usado' en Google Sheets
 *
 * Variables de entorno requeridas:
 *   ANTHROPIC_API_KEY      — API key de Claude
 *   N8N_WEBHOOK_URL        — URL del webhook de n8n
 *   GOOGLE_SHEETS_ID       — ID de la hoja de Google Sheets
 *   GOOGLE_SERVICE_EMAIL   — Email de la cuenta de servicio
 *   GOOGLE_PRIVATE_KEY     — Clave privada de la cuenta de servicio
 */

const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

// Timeout extendido para Netlify Functions (máximo 26s en plan gratis, 30s en Pro)
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  let datos;
  try {
    datos = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON inválido' }) };
  }

  const {
    token, email,
    descripcion_negocio, cliente_ideal, precio, pais, ingresos,
    url_web, url_otra_red,
    frustracion, intentos_previos, competidor,
    captura_perfil, // base64 string o null
  } = datos;

  if (!token || !email || !descripcion_negocio) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Datos incompletos' }) };
  }

  // ── 1. Fetch del sitio web ──────────────────────────────────
  let contenidoWeb = '';
  if (url_web) {
    try {
      const res = await fetch(url_web, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RutaDigital/1.0)' },
        signal: AbortSignal.timeout(8000),
      });
      const html = await res.text();
      // Extraer solo el texto visible (sin tags)
      contenidoWeb = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 4000); // Limitar para no sobrecargar el contexto
    } catch (e) {
      contenidoWeb = `No se pudo acceder al sitio: ${e.message}`;
    }
  }

  // ── 2. Preparar mensajes para Claude ───────────────────────
  const rangoIngresos = {
    'menos-500':   'menos de $500 USD/mes (etapa inicial)',
    '500-2000':    '$500–$2,000 USD/mes (etapa de crecimiento temprano)',
    '2000-10000':  '$2,000–$10,000 USD/mes (etapa de crecimiento)',
    'mas-10000':   'más de $10,000 USD/mes (etapa de escala)',
  }[ingresos] || ingresos;

  const systemPrompt = `Eres el estratega digital principal de Ruta Digital, una agencia especializada en acompañamiento digital para negocios latinoamericanos. Tu método es el Triángulo Digital: Ruta (canales y plan de acción), Mensaje (comunicación y ángulos de venta) y Oferta (posicionamiento y estructura de la oferta).

Vas a generar una Estrategia Digital Personalizada completa para un cliente que pagó $30 por este análisis. El documento debe ser profundo, accionable y personalizado — no genérico. Usa toda la información del cliente para hacer recomendaciones específicas a su situación.

El documento HTML que generes debe tener exactamente esta estructura:
1. Diagnóstico inicial (análisis de la situación actual, brechas detectadas)
2. Cliente ideal detallado (perfil psicográfico + demográfico + dolores específicos)
3. Nichos prioritarios (2-3 nichos concretos con justificación)
4. Estructura del funnel recomendado (con etapas específicas para su negocio)
5. Ángulos de venta (5 ángulos concretos basados en sus dolores y diferenciadores)
6. Canales prioritarios (máximo 3, con por qué cada uno y qué tipo de contenido)
7. Plan de acción 30 días (semana a semana, tareas específicas)
8. Próximos pasos con Ruta Digital (presentación de servicios como continuación natural)

Reglas:
- Sé específico y directo. Nada de consejos genéricos.
- Usa el lenguaje y contexto del cliente (su industria, su mercado, su nivel)
- El tono es profesional pero cercano, latinoamericano
- El plan de 30 días debe ser realista para el nivel de ingresos del cliente
- La sección final debe conectar naturalmente con los servicios de Ruta Digital sin sentirse como publicidad forzada`;

  const mensajeUsuario = `Genera la Estrategia Digital Personalizada para este cliente:

**NEGOCIO:**
- Qué vende: ${descripcion_negocio}
- Cliente ideal (según el cliente): ${cliente_ideal}
- Precio(s): ${precio}
- Mercado: ${pais}
- Ingresos actuales: ${rangoIngresos}

**PRESENCIA ONLINE:**
- Sitio web: ${url_web || 'No tiene'}
- Otro canal: ${url_otra_red || 'No indicó'}
${contenidoWeb ? `\n- Contenido del sitio web:\n${contenidoWeb}` : ''}

**SITUACIÓN ACTUAL:**
- Mayor frustración: ${frustracion}
- Qué ha intentado antes: ${intentos_previos}
- Competidor principal: ${competidor}

${captura_perfil ? 'Analiza también la captura de pantalla de su perfil en redes sociales adjunta.' : ''}

Genera el documento HTML completo con estilos inline, listo para imprimir como PDF. Usa los colores de Ruta Digital: verde principal #1a9e6b, tipografía limpia, diseño profesional. El documento debe comenzar con una portada que incluya el nombre/descripción del negocio del cliente y la fecha de hoy.`;

  // Construir mensajes con o sin imagen
  const mensajesParaClaude = [
    {
      role: 'user',
      content: captura_perfil
        ? [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: captura_perfil.match(/data:(image\/\w+);/)?.[1] || 'image/jpeg',
                data: captura_perfil.replace(/^data:image\/\w+;base64,/, ''),
              },
            },
            { type: 'text', text: mensajeUsuario },
          ]
        : mensajeUsuario,
    },
  ];

  // ── 3. Llamar a Claude API ──────────────────────────────────
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let documentoHTML;
  try {
    const respuesta = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 8000,
      system: systemPrompt,
      messages: mensajesParaClaude,
    });

    documentoHTML = respuesta.content[0].text;

    // Si Claude devolvió markdown en lugar de HTML puro, lo envolvemos
    if (!documentoHTML.trim().startsWith('<!DOCTYPE') && !documentoHTML.trim().startsWith('<html')) {
      documentoHTML = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Estrategia Digital</title></head><body>${documentoHTML}</body></html>`;
    }

  } catch (error) {
    console.error('Error llamando a Claude:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Error generando la estrategia. Por favor intenta de nuevo.' }),
    };
  }

  // ── 4. Enviar a Make.com ────────────────────────────────────
  try {
    await fetch(process.env.N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        token,
        documento_html: documentoHTML,
        nombre_negocio: descripcion_negocio.slice(0, 80),
        fecha: new Date().toISOString(),
      }),
    });
  } catch (error) {
    console.error('Error enviando a Make.com:', error);
    // No retornamos error al cliente — el documento se generó, solo falló el envío
    // Make.com debería tener reintentos configurados
  }

  // ── 5. Marcar token como 'usado' en Google Sheets ──────────
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_EMAIL,
        private_key:  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });

    // Buscar la fila del token para actualizar su estado
    const getRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Ventas!H:H', // columna H = Token
    });

    const filas    = getRes.data.values || [];
    const indice   = filas.findIndex(f => f[0] === token);
    const numFila  = indice + 1; // Sheets es 1-indexed

    if (numFila > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        range: `Ventas!B${numFila}`, // columna B = Status
        valueInputOption: 'RAW',
        requestBody: { values: [['usado']] },
      });
    }
  } catch (error) {
    console.error('Error actualizando Google Sheets:', error);
    // No crítico — continuar
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, mensaje: 'Estrategia generada y enviada por email' }),
  };
};

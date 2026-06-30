/**
 * validar-pago.js
 * GET /.netlify/functions/validar-pago?token=XXX
 *
 * Consulta Google Sheets para verificar si el token existe y el pago
 * fue confirmado por el webhook de Hotmart.
 *
 * Variables de entorno requeridas (Netlify → Site settings → Env vars):
 *   GOOGLE_SHEETS_ID       — ID de la hoja (parte de la URL de Google Sheets)
 *   GOOGLE_SERVICE_EMAIL   — Email de la cuenta de servicio
 *   GOOGLE_PRIVATE_KEY     — Clave privada de la cuenta de servicio (con \n literales)
 */

const { GoogleAuth } = require('google-auth-library');
const { google }     = require('googleapis');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  const token = event.queryStringParameters?.token;

  if (!token) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ valid: false, error: 'Token requerido' }),
    };
  }

  try {
    // Autenticar con Google usando cuenta de servicio
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_EMAIL,
        private_key:  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });

    // Columnas en la hoja "Ventas":
    // A: ID orden | B: Status | C: Nombre | D: Correo | E: Telefono | F: Fecha | G: Total | H: Token
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Ventas!A:H',
    });

    const filas = response.data.values || [];

    // Buscar la fila donde la columna H (índice 7) coincide con el token
    const fila = filas.find(f => f[7] === token);

    if (!fila) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ valid: false, error: 'Token no encontrado' }),
      };
    }

    const estado = fila[1]; // columna B: Status ('confirmado' | 'pendiente' | 'usado')

    if (estado !== 'confirmado') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ valid: false, error: `Estado del pago: ${estado}` }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ valid: true, email: fila[3] }), // columna D: Correo
    };

  } catch (error) {
    console.error('Error validando token:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ valid: false, error: 'Error interno al verificar el pago' }),
    };
  }
};

exports.handler = async function(event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    
    // Log key status (not the key itself)
    console.log('API Key exists:', !!apiKey);
    console.log('API Key length:', apiKey ? apiKey.length : 0);
    console.log('API Key starts with sk-ant:', apiKey ? apiKey.startsWith('sk-ant') : false);

    const { messages, system } = JSON.parse(event.body);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system,
        messages
      })
    });

    console.log('Anthropic response status:', response.status);
    const data = await response.json();
    console.log('Response type:', data.type);
    console.log('Has content:', !!data.content);

    if (data.error) {
      console.log('API Error:', data.error.type, data.error.message);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ text: '', error: data.error.message })
      };
    }

    const text = data.content && data.content.length > 0
      ? data.content.map(b => b.text || '').join('')
      : '';

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: JSON.stringify({ text })
    };
  } catch (error) {
    console.log('Catch error:', error.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message, text: '' })
    };
  }
};

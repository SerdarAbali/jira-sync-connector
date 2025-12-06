import { processIncomingWebhook } from '../services/sync/incoming-sync.js';

export async function run(request) {
  console.log(`📨 Webtrigger invoked. Method: ${request.method}`);
  
  try {
    // Handle GET requests (Browser checks)
    if (request.method === 'GET') {
      console.log('ℹ️ Handling GET request - returning status message');
      const response = {
        body: JSON.stringify({ message: 'Sync Connector Webhook is active. Please use POST for events.' }),
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' }
      };
      console.log('✅ Returning response:', JSON.stringify(response));
      return response;
    }

    // Parse Body safely
    let body;
    try {
      if (!request.body) {
        throw new Error('Empty body');
      }
      body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
    } catch (e) {
      console.error('Failed to parse webhook body:', e);
      return {
        body: JSON.stringify({ error: 'Invalid JSON body' }),
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' }
      };
    }

    let { secret } = request.queryParameters || {};
    
    // Normalize secret (handle array if multiple params or platform quirk)
    if (Array.isArray(secret)) {
      secret = secret[0];
    }

    if (!secret) {
      console.warn('Missing secret in query parameters');
      return {
        body: JSON.stringify({ error: 'Missing secret' }),
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' }
      };
    }
    
    const result = await processIncomingWebhook(body, secret);
    
    return {
      body: JSON.stringify(result.body),
      statusCode: result.status,
      headers: { 'Content-Type': 'application/json' }
    };
  } catch (error) {
    console.error('Error processing incoming webhook:', error);
    return {
      body: JSON.stringify({ error: 'Internal Server Error', details: error.message }),
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' }
    };
  }
}

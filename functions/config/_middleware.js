export function onRequest(context) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(context.request.url).pathname).replace(/[\\/]+/g, '/').toLowerCase();
  } catch (_) {
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  if (pathname === '/config/questions.json') {
    return new Response(null, {
      status: 404,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  }
  if (pathname === '/config/settings.json') {
    return handleSettings(context);
  }
  return context.next();
}

async function handleSettings(context) {
  const response = await context.next();
  if (!response || typeof response.json !== 'function') return response;
  try {
    const data = await response.json();
    if (data && data.firebase) {
      const env = context.env || {};
      if (env.FIREBASE_API_KEY) data.firebase.apiKey = env.FIREBASE_API_KEY;
      if (env.FIREBASE_AUTH_DOMAIN) data.firebase.authDomain = env.FIREBASE_AUTH_DOMAIN;
      if (env.FIREBASE_PROJECT_ID) data.firebase.projectId = env.FIREBASE_PROJECT_ID;
      if (env.FIREBASE_STORAGE_BUCKET) data.firebase.storageBucket = env.FIREBASE_STORAGE_BUCKET;
      if (env.FIREBASE_MESSAGING_SENDER_ID) data.firebase.messagingSenderId = env.FIREBASE_MESSAGING_SENDER_ID;
      if (env.FIREBASE_APP_ID) data.firebase.appId = env.FIREBASE_APP_ID;
      if (env.FIREBASE_MEASUREMENT_ID) data.firebase.measurementId = env.FIREBASE_MEASUREMENT_ID;
    }
    return new Response(JSON.stringify(data, null, 2), {
      status: response.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch (_) {
    return response;
  }
}

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
  return context.next();
}

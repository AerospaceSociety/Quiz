export default {
  async scheduled(_controller, env) {
    const response = await fetch(env.RETENTION_ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${env.RETENTION_PURGE_TOKEN}` },
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Retention endpoint returned HTTP ${response.status}`);
    const result = await response.json();
    console.log(JSON.stringify({ type: 'retention_purge', ...result }));
  }
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID.test(v);

export function pageParams(query) {
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const offset = Math.max(0, parseInt(query.offset, 10) || 0);
  return { limit, offset };
}

export const fail = (res, status, error) =>
  res.status(status).json({ ok: false, error });

export function serverError(res, context, error) {
  console.error(context + ':', error?.message || error);
  return fail(res, 500, 'Internal server error');
}
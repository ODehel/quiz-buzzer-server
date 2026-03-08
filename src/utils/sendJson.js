/**
 * Envoie une réponse JSON.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {number} statusCode
 * @param {Object} body
 * @param {Object} [headers={}]
 */
export function sendJson(res, statusCode, body, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
    ...headers,
  });
  res.end(json);
}

/**
 * Envoie une réponse d'erreur AppError.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {import("../errors/AppError.js").AppError} err
 * @param {Object} [headers={}]
 */
export function sendError(res, err, headers = {}) {
  sendJson(res, err.status, err.toJSON(), headers);
}
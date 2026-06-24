/**
 * Límites de validación de ARIA en un solo sitio.
 *
 * Filosofía del scope: ARIA registra el scope REAL declarado por el agente
 * (registro inmutable de todo). No se impone un tope artificial bajo — un
 * agente con 2 acciones usa 2; uno con 80, usa 80. El único límite es un
 * guardarraíl generoso contra payloads abusivos (DoS), no una restricción
 * de producto. Cada acción sigue validándose por formato (verb:resource) y
 * longitud individual.
 */
export const MAX_SCOPE_ACTIONS = 200;

/** Longitud máxima de una sola acción de scope (p.ej. "process:sale"). */
export const MAX_SCOPE_ACTION_LENGTH = 50;

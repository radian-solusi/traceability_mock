// Tiny publish/subscribe bus.
// In the mock it stands in for the WebSocket channel between the Dashboard
// Traceability Application Server (DTAS) and the browser: every state change the
// server would push (new OPC event, pipe movement, CTMS status...) is emitted here.
//
// Topics used across the app:
//   state            any change (payload: { type, ... })  -> pages refresh
//   opc:event        a PLC/OPC/camera event arrived
//   trace:movement   an IN/OUT movement was recorded
//   identify:required  automatic identification failed, operator must confirm
//   inspection:required  OUT recorded at a station that needs an inspection result
//   ctms:status      a CTMS submission changed status
//   dmc:batch        DMC master data received
//   opc:tags         OPC tag values refreshed
//   notify           a notification was raised
//   theme            light/dark theme changed

const handlers = new Map();

export function on(topic, fn) {
  if (!handlers.has(topic)) handlers.set(topic, new Set());
  handlers.get(topic).add(fn);
  return () => handlers.get(topic)?.delete(fn);
}

export function emit(topic, payload) {
  const run = (fn, ...args) => {
    try {
      fn(...args);
    } catch (err) {
      console.error(`[bus] handler for "${topic}" failed`, err);
    }
  };
  for (const fn of [...(handlers.get(topic) || [])]) run(fn, payload);
  if (topic !== '*') for (const fn of [...(handlers.get('*') || [])]) run(fn, topic, payload);
}

/** Emit the generic "state" topic plus a specific one. */
export function changed(type, payload = {}) {
  emit(type, payload);
  emit('state', { type, ...payload });
}

/** Host-only identity. Each authenticated transport connection gets its own signal;
 * neither renderer payloads nor public frames can supply or copy this authority.
 * Direct in-process callers share the trusted host identity by default.
 */
export type BotComputerClient = AbortSignal
export const HOST_COMPUTER_CLIENT: BotComputerClient = new AbortController().signal

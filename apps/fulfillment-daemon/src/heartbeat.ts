export type LogFn = (message: string) => void;

export function heartbeat(input: {
  log: LogFn;
  tickN: number;
  ordersInProgress: number;
}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    daemon: "fulfillment-daemon",
    event: "heartbeat",
    tick: input.tickN,
    orders_in_progress: input.ordersInProgress,
  });
  input.log(line);
}

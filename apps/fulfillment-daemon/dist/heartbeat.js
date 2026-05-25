export function heartbeat(input) {
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        daemon: "fulfillment-daemon",
        event: "heartbeat",
        tick: input.tickN,
        orders_in_progress: input.ordersInProgress,
    });
    input.log(line);
}

import { OrderAlreadyClaimed } from "./api-client.js";
import { heartbeat } from "./heartbeat.js";
import { runAuditRunner, TimeoutError } from "./runner.js";
import { isProcessed, markProcessed } from "./state.js";
export async function runTick(deps) {
    const { apiClient, config, log } = deps;
    let state = deps.state;
    let processed = 0;
    let skipped = 0;
    let failed = 0;
    heartbeat({ log, tickN: deps.tickN, ordersInProgress: 0 });
    let orders;
    try {
        orders = await apiClient.listPaidOrders(10);
    }
    catch (error) {
        log(`[fulfillment-daemon] listPaidOrders error: ${error instanceof Error ? error.message : String(error)}`);
        return { state, processed, skipped, failed };
    }
    for (const order of orders) {
        if (isProcessed(state, order.id)) {
            skipped++;
            continue;
        }
        // Claim
        try {
            await apiClient.claimOrder(order.id);
        }
        catch (error) {
            if (error instanceof OrderAlreadyClaimed) {
                log(`[fulfillment-daemon] order ${order.id} already claimed, skipping`);
                skipped++;
                continue;
            }
            log(`[fulfillment-daemon] claimOrder ${order.id} error: ${error instanceof Error ? error.message : String(error)}`);
            skipped++;
            continue;
        }
        // Run the audit-runner
        let runnerResult = null;
        let runnerError = null;
        if (config.dryRun) {
            log(`[fulfillment-daemon] dry-run: skipping runner for order ${order.id}`);
            runnerResult = {
                report_md: "DRY_RUN",
                severity_counts: { high: 0, medium: 0, low: 0, info: 0 },
                verdict: "PASS",
            };
        }
        else {
            try {
                runnerResult = await runAuditRunner({
                    runnerCliPath: config.runnerCliPath,
                    contractAddress: order.contract_address,
                    buyerEmail: order.buyer_email,
                    orderId: order.id,
                });
            }
            catch (error) {
                runnerError =
                    error instanceof TimeoutError
                        ? `Runner timed out: ${error.message}`
                        : error instanceof Error
                            ? error.message
                            : String(error);
                log(`[fulfillment-daemon] runner failed for order ${order.id}: ${runnerError}`);
            }
        }
        if (runnerResult) {
            try {
                await apiClient.reportOrder(order.id, {
                    report_md: runnerResult.report_md,
                    severity_counts: runnerResult.severity_counts,
                    verdict: runnerResult.verdict,
                });
                log(`[fulfillment-daemon] order ${order.id} reported successfully`);
                processed++;
            }
            catch (error) {
                log(`[fulfillment-daemon] reportOrder ${order.id} error: ${error instanceof Error ? error.message : String(error)}`);
                failed++;
            }
        }
        else if (runnerError) {
            // Report failure and attempt refund
            try {
                await apiClient.reportOrder(order.id, {
                    report_md: `Audit could not be completed. ${runnerError}. Your $${order.amount_cents / 100} has been refunded automatically. Reply to this email if you need help.`,
                    severity_counts: { high: 0, medium: 0, low: 0, info: 0 },
                    verdict: "FAIL",
                    failure_reason: runnerError,
                });
            }
            catch (reportErr) {
                log(`[fulfillment-daemon] reportOrder (failure) ${order.id} error: ${reportErr instanceof Error ? reportErr.message : String(reportErr)}`);
            }
            try {
                await apiClient.refundOrder(order.id, runnerError);
                log(`[fulfillment-daemon] order ${order.id} refunded after runner failure`);
            }
            catch (refundErr) {
                log(`[fulfillment-daemon] refundOrder ${order.id} error: ${refundErr instanceof Error ? refundErr.message : String(refundErr)}`);
            }
            failed++;
        }
        // Mark processed regardless of outcome to avoid re-attempting
        state = markProcessed(state, order.id);
    }
    return { state, processed, skipped, failed };
}

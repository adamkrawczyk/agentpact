// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AgentPactDeadMansSwitch
 * @notice Dead-man's switch contract for Layer B (off-chain server) custody.
 *         Per settlement_2705 Phase 0 decision: Q6 default applied →
 *         deploys with TIMER_DISABLED so the switch is dormant. Funds in
 *         the upstream Gnosis Safe stay 1-of-1 Adam-only until Adam
 *         explicitly designates a successor in a future redeploy.
 *
 * @dev Two operating modes:
 *
 *      MODE 1 (default, Q6 unanswered): TIMER_DISABLED = true. The switch
 *      deploys, the address is published, but the 180-day timer never
 *      starts. heartbeat() is a no-op revert. No successor relay exists.
 *      If Adam dies, Layer A (contracts) keeps working forever, Layer B
 *      (server) keeps working as long as auto-funding survives, and any
 *      future heir can pursue Safe recovery via signer threshold
 *      reconfiguration (off-chain process, not a contract concern).
 *
 *      MODE 2 (explicit opt-in): redeploy with TIMER_DISABLED = false and
 *      a non-zero `successor` address + non-zero `heartbeatCaller`. After
 *      `INACTIVITY_PERIOD` of no `heartbeat()` call by `heartbeatCaller`,
 *      the successor can call `relayCoSignature()` to gain co-signing
 *      authority on the upstream Gnosis Safe. This contract holds the
 *      authority indirectly: Safe signer-3 is THIS contract; we only
 *      relay successor calls when the inactivity window has elapsed.
 *
 *      Out of scope: integration with the actual Safe — that wiring is
 *      a Phase G follow-up that needs the deployed Safe address.
 *
 * @dev Adam answers locked in plan-doc:
 *      Q5: Safe deploys 1-of-1 Adam-only.
 *      Q6: dead-man's switch deploys with timer DISABLED.
 *      Q7: moot (heartbeat caller wired only if Q6 changes).
 */
contract AgentPactDeadMansSwitch {
    // ── Immutable configuration ────────────────────────────────────────

    /// @notice When true, the 180-day inactivity timer never starts and
    ///         the successor relay path is unreachable. Q6 default.
    bool public immutable TIMER_DISABLED;

    /// @notice Address whose call to heartbeat() resets the inactivity
    ///         timer. address(0) when TIMER_DISABLED.
    address public immutable heartbeatCaller;

    /// @notice Address that gains relay authority after the inactivity
    ///         window elapses. address(0) when TIMER_DISABLED.
    address public immutable successor;

    /// @notice Inactivity window in seconds. Hard-coded at 180 days to
    ///         match plan § 13.5; not configurable.
    uint64 public constant INACTIVITY_PERIOD = 180 days;

    // ── Mutable state ──────────────────────────────────────────────────

    /// @notice Unix timestamp of the most recent heartbeat. Initialized
    ///         to deploy time so the successor cannot relay during the
    ///         first 180 days even if heartbeat() is never called.
    uint64 public lastHeartbeatAt;

    /// @notice Audit trail of relay calls. Each relay call appends.
    uint256 public relayCallCount;

    // ── Events ─────────────────────────────────────────────────────────

    event Heartbeat(address indexed caller, uint64 at);
    event SuccessorRelayed(address indexed successor, bytes32 indexed digest, uint256 index);

    // ── Constructor ────────────────────────────────────────────────────

    /**
     * @param _timerDisabled Per Q6 default — pass `true` and leave the
     *                       other params as zero to deploy in dormant mode.
     * @param _heartbeatCaller Must be address(0) when _timerDisabled is true.
     * @param _successor Must be address(0) when _timerDisabled is true.
     */
    constructor(bool _timerDisabled, address _heartbeatCaller, address _successor) {
        if (_timerDisabled) {
            require(_heartbeatCaller == address(0), "DeadMansSwitch: caller must be zero when disabled");
            require(_successor == address(0), "DeadMansSwitch: successor must be zero when disabled");
        } else {
            require(_heartbeatCaller != address(0), "DeadMansSwitch: caller required");
            require(_successor != address(0), "DeadMansSwitch: successor required");
            require(_heartbeatCaller != _successor, "DeadMansSwitch: caller and successor must differ");
        }
        TIMER_DISABLED = _timerDisabled;
        heartbeatCaller = _heartbeatCaller;
        successor = _successor;
        lastHeartbeatAt = uint64(block.timestamp);
    }

    // ── Heartbeat path ────────────────────────────────────────────────

    /**
     * @notice Resets the inactivity timer. Reverts when the switch is
     *         deployed with TIMER_DISABLED so a misconfigured caller
     *         cannot mistake a no-op for liveness.
     */
    function heartbeat() external {
        require(!TIMER_DISABLED, "DeadMansSwitch: timer disabled");
        require(msg.sender == heartbeatCaller, "DeadMansSwitch: only heartbeatCaller");
        lastHeartbeatAt = uint64(block.timestamp);
        emit Heartbeat(msg.sender, lastHeartbeatAt);
    }

    /**
     * @notice Returns true iff the successor relay path is currently
     *         live. False when the timer is disabled OR the inactivity
     *         window has not yet elapsed.
     */
    function isRelayActive() external view returns (bool) {
        if (TIMER_DISABLED) return false;
        return block.timestamp >= uint256(lastHeartbeatAt) + uint256(INACTIVITY_PERIOD);
    }

    // ── Successor relay path ──────────────────────────────────────────

    /**
     * @notice Successor records a co-signature digest after the inactivity
     *         window has elapsed. The off-chain Safe transaction service
     *         observes this event and feeds the digest into the multisig
     *         signing flow as our contract's signature. Reverts under
     *         every state except {TIMER_DISABLED=false, window elapsed,
     *         msg.sender == successor}.
     */
    function relayCoSignature(bytes32 digest) external returns (uint256 index) {
        require(!TIMER_DISABLED, "DeadMansSwitch: timer disabled");
        require(msg.sender == successor, "DeadMansSwitch: only successor");
        require(
            block.timestamp >= uint256(lastHeartbeatAt) + uint256(INACTIVITY_PERIOD),
            "DeadMansSwitch: window not elapsed"
        );
        index = relayCallCount++;
        emit SuccessorRelayed(msg.sender, digest, index);
    }
}

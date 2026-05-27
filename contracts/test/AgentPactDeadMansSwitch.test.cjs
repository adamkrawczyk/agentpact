const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgentPactDeadMansSwitch", function () {
  this.timeout(60000);

  async function deployDormant() {
    const F = await ethers.getContractFactory("AgentPactDeadMansSwitch");
    return F.deploy(true, ethers.ZeroAddress, ethers.ZeroAddress);
  }

  async function deployArmed() {
    const [, , heartbeater, successor] = await ethers.getSigners();
    const F = await ethers.getContractFactory("AgentPactDeadMansSwitch");
    const c = await F.deploy(false, heartbeater.address, successor.address);
    return { c, heartbeater, successor };
  }

  describe("Q6 default — TIMER_DISABLED", function () {
    it("deploys with zero addresses and reports relay inactive", async function () {
      const c = await deployDormant();
      expect(await c.TIMER_DISABLED()).to.equal(true);
      expect(await c.heartbeatCaller()).to.equal(ethers.ZeroAddress);
      expect(await c.successor()).to.equal(ethers.ZeroAddress);
      expect(await c.isRelayActive()).to.equal(false);
    });

    it("heartbeat reverts when timer is disabled", async function () {
      const c = await deployDormant();
      await expect(c.heartbeat()).to.be.revertedWith("DeadMansSwitch: timer disabled");
    });

    it("relayCoSignature reverts when timer is disabled", async function () {
      const c = await deployDormant();
      await expect(c.relayCoSignature(ethers.ZeroHash)).to.be.revertedWith(
        "DeadMansSwitch: timer disabled"
      );
    });

    it("rejects nonzero caller/successor when TIMER_DISABLED is requested", async function () {
      const F = await ethers.getContractFactory("AgentPactDeadMansSwitch");
      const [, , a] = await ethers.getSigners();
      await expect(F.deploy(true, a.address, ethers.ZeroAddress)).to.be.revertedWith(
        "DeadMansSwitch: caller must be zero when disabled"
      );
      await expect(F.deploy(true, ethers.ZeroAddress, a.address)).to.be.revertedWith(
        "DeadMansSwitch: successor must be zero when disabled"
      );
    });
  });

  describe("Armed mode — opt-in", function () {
    it("requires non-zero caller + successor and they must differ", async function () {
      const F = await ethers.getContractFactory("AgentPactDeadMansSwitch");
      const [, , a] = await ethers.getSigners();
      await expect(F.deploy(false, ethers.ZeroAddress, a.address)).to.be.revertedWith(
        "DeadMansSwitch: caller required"
      );
      await expect(F.deploy(false, a.address, ethers.ZeroAddress)).to.be.revertedWith(
        "DeadMansSwitch: successor required"
      );
      await expect(F.deploy(false, a.address, a.address)).to.be.revertedWith(
        "DeadMansSwitch: caller and successor must differ"
      );
    });

    it("heartbeat resets the timer, only from designated caller", async function () {
      const { c, heartbeater, successor } = await deployArmed();
      await expect(c.connect(successor).heartbeat()).to.be.revertedWith(
        "DeadMansSwitch: only heartbeatCaller"
      );
      await c.connect(heartbeater).heartbeat();
      // Relay not yet active — window hasn't elapsed
      expect(await c.isRelayActive()).to.equal(false);
    });

    it("successor relay reverts before the inactivity window elapses", async function () {
      const { c, successor } = await deployArmed();
      await expect(c.connect(successor).relayCoSignature(ethers.id("digest"))).to.be.revertedWith(
        "DeadMansSwitch: window not elapsed"
      );
    });

    it("successor can relay after 180 days of silence", async function () {
      const { c, successor } = await deployArmed();
      // jump 181 days
      await ethers.provider.send("evm_increaseTime", [181 * 24 * 3600]);
      await ethers.provider.send("evm_mine", []);
      expect(await c.isRelayActive()).to.equal(true);
      await expect(c.connect(successor).relayCoSignature(ethers.id("digest")))
        .to.emit(c, "SuccessorRelayed");
      expect(await c.relayCallCount()).to.equal(1n);
    });

    it("non-successor cannot relay even after window elapses", async function () {
      const { c, heartbeater } = await deployArmed();
      await ethers.provider.send("evm_increaseTime", [181 * 24 * 3600]);
      await ethers.provider.send("evm_mine", []);
      await expect(c.connect(heartbeater).relayCoSignature(ethers.ZeroHash)).to.be.revertedWith(
        "DeadMansSwitch: only successor"
      );
    });
  });
});

import { createWalletClient, createPublicClient, http, formatUnits } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
const ESCROW = process.env.ESCROW_CONTRACT_ADDRESS;
const USDC = (process.env.USDC_CONTRACT_ADDRESS ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const PK = process.env.PLATFORM_PRIVATE_KEY;
const RPC = process.env.BASE_RPC_URL ?? process.env.RPC_URL ?? 'https://mainnet.base.org';
const buyer = privateKeyToAccount(PK);
const seller = '0xcB43c996CbaDC3AC2FADab0449297890F727e9F9';
const milestoneId = 'e773e44e-3a1e-47be-94ae-97d081bace48';
const msBytes = (`0x${milestoneId.replace(/-/g, '').padStart(64, '0')}`);
const usdcAbi = [
    { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
];
const escrowAbi = [
    { name: 'acceptMilestone', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'milestoneId', type: 'bytes32' }], outputs: [] },
    { name: 'milestones', type: 'function', stateMutability: 'view', inputs: [{ name: '', type: 'bytes32' }], outputs: [{ name: 'dealId', type: 'bytes32' }, { name: 'buyer', type: 'address' }, { name: 'seller', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'status', type: 'uint8' }, { name: 'createdAt', type: 'uint256' }] },
];
(async () => {
    const pub = createPublicClient({ chain: base, transport: http(RPC) });
    const w = createWalletClient({ account: buyer, chain: base, transport: http(RPC) });
    const buyerBefore = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [buyer.address] });
    const sellerBefore = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [seller] });
    const msBefore = await pub.readContract({ address: ESCROW, abi: escrowAbi, functionName: 'milestones', args: [msBytes] });
    console.log('buyer_before', formatUnits(buyerBefore, 6));
    console.log('seller_before', formatUnits(sellerBefore, 6));
    console.log('milestone_status_before', Number(msBefore[4]));
    const tx = await w.writeContract({ address: ESCROW, abi: escrowAbi, functionName: 'acceptMilestone', args: [msBytes] });
    console.log('accept_tx', tx);
    await pub.waitForTransactionReceipt({ hash: tx, confirmations: 2 });
    const buyerAfter = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [buyer.address] });
    const sellerAfter = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [seller] });
    const msAfter = await pub.readContract({ address: ESCROW, abi: escrowAbi, functionName: 'milestones', args: [msBytes] });
    console.log('buyer_after', formatUnits(buyerAfter, 6));
    console.log('seller_after', formatUnits(sellerAfter, 6));
    console.log('buyer_delta', formatUnits(buyerAfter - buyerBefore, 6));
    console.log('seller_delta', formatUnits(sellerAfter - sellerBefore, 6));
    console.log('milestone_status_after', Number(msAfter[4]));
})();

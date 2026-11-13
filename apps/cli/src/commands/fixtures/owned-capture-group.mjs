/**
 * Test-only ownership receipts for capture wrappers. The wrapper writes its own
 * PID and the identities of itself/its reader before admitting fixture commands.
 * PPIDs are never cleanup authority, and an emptied/recycled group is never
 * signalled numerically. Confirmed members go through the normal per-PID gate.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readProcessTable, sendVerifiedSignal } from '@agentmonitors/core';
import { ownedWorkerTerminated } from '../../../../../scripts/owned-worker-terminated.mjs';

/** @typedef {import('@agentmonitors/core').ProcessIdentityRecord} Identity */
/** @typedef {{group:number, records:Identity[]}} Receipt */

/** Parse only the native identity formats explicitly written by the owned wrapper. @param {string} text @returns {Receipt} @internal */
export function parseOwnedCaptureGroup(text) {
  const [leader, format, ...lines] = text.trim().split('\n');
  const group = Number(leader);
  /** @type {Identity[]} */
  const records = [];
  for (const line of lines) {
    if (format === 'proc') {
      const close = line.lastIndexOf(')');
      const fields = line
        .slice(close + 1)
        .trim()
        .split(/\s+/);
      records.push({
        pid: Number(line.slice(0, line.indexOf('(')).trim()),
        pgid: Number(fields[2]),
        startTime: fields[19] ?? '',
      });
    } else if (format === 'ps') {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S.*\S)\s*$/.exec(line);
      if (match)
        records.push({
          pid: Number(match[1]),
          pgid: Number(match[2]),
          startTime: match[3] ?? '',
        });
    } else throw new Error('Unknown owned capture identity format');
  }
  if (
    !Number.isSafeInteger(group) ||
    group <= 1 ||
    !records.some((p) => p.pid === group && p.pgid === group) ||
    records.some(
      (p) =>
        !Number.isSafeInteger(p.pid) ||
        p.pid <= 1 ||
        p.pgid !== group ||
        !p.startTime,
    )
  ) {
    throw new Error(
      'Capture wrapper did not create an exclusive process group',
    );
  }
  return { group, records };
}

/**
 * Refuse cleanup unless an initial owned incarnation still confirms current group
 * continuity. Empty groups and positively terminal remnants need no signal;
 * terminal evidence failures remain errors. All actual signals recheck each PID.
 * @param {Receipt} receipt
 * @param {{readTable?:typeof readProcessTable, signal?:(record:Identity)=>Promise<import('@agentmonitors/core').SignalOutcome>, isTerminated?:(pid:number)=>boolean}} [options]
 * @returns {Promise<number>}
 * @internal
 */
export async function cleanupOwnedCaptureGroup(receipt, options = {}) {
  // Revalidate the receipt even when a caller did not use the parser.
  if (
    !receipt.records.some(
      (p) => p.pid === receipt.group && p.pgid === receipt.group,
    )
  )
    throw new Error(
      'Capture wrapper did not create an exclusive process group',
    );
  const table = await (options.readTable ?? readProcessTable)();
  if (!table.supported) throw new Error(table.reason);
  const members = table.processes.filter((p) => p.pgid === receipt.group);
  // Linux can retain orphan zombies after every recorded anchor has exited.
  // They need no signal or live ownership authority. Read all terminal evidence
  // before signalling anything, so unavailable evidence cannot produce a partial
  // cleanup or turn a running, unverified member into an accepted empty group.
  const isTerminated = options.isTerminated ?? ownedWorkerTerminated;
  const activeMembers = members.filter((member) => !isTerminated(member.pid));
  // Keep ownership evidence auditable without exposing captured command output.
  console.log(
    JSON.stringify({
      ownedCaptureGroup: receipt.group,
      currentMemberPids: members.map((p) => p.pid),
      activeMemberPids: activeMembers.map((p) => p.pid),
    }),
  );
  if (activeMembers.length === 0) return receipt.group;
  if (
    !members.some((p) =>
      receipt.records.some(
        (known) =>
          known.pid === p.pid &&
          known.startTime === p.startTime &&
          known.pgid === p.pgid,
      ),
    )
  )
    throw new Error(
      'Owned capture group continuity cannot be confirmed; nothing signalled',
    );
  for (const member of activeMembers) {
    const outcome = await (
      options.signal ??
      ((record) =>
        sendVerifiedSignal({ kind: 'recorded-process', record }, 'SIGKILL', {
          action: 'owned capture fixture cleanup',
        }))
    )(member);
    if (outcome.status === 'abstained' || outcome.status === 'failed')
      throw new Error('Owned capture fixture cleanup was not confirmed');
  }
  return receipt.group;
}

/** The signal fixture can interrupt only its positively recorded wrapper, never a PPID guess. @param {string} filename @returns {Promise<void>} @internal */
export async function signalOwnedCaptureRoot(filename) {
  const receipt = parseOwnedCaptureGroup(readFileSync(filename, 'utf8'));
  const record = receipt.records.find((p) => p.pid === receipt.group);
  if (!record) throw new Error('Missing capture wrapper identity');
  const result = await sendVerifiedSignal(
    { kind: 'recorded-process', record },
    'SIGTERM',
    { action: 'owned capture signal fixture' },
  );
  if (result.status !== 'sent')
    throw new Error('Owned capture wrapper signal was withheld');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Missing owned capture receipt path');
  await signalOwnedCaptureRoot(process.argv[2]);
}

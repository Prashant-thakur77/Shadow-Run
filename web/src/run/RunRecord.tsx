import type { ReactNode } from 'react';
import type { Attempt } from '../api/types';
import { bytes, ms, num } from '../lib/format';
import { Mark, Tag } from '../ui/bits';
import { plainNetwork } from '../ui/Figure';

function Checkpoint({ n, title, ok, children }: { n: number; title: string; ok: boolean | undefined; children: ReactNode }) {
  const tone = ok === true ? 'good' : ok === false ? 'bad' : 'neutral';
  return (
    <li className={`cp is-${tone}`}>
      <div className="cp-head">
        <Mark tone={tone} size={16} />
        <span className="mono cp-n">{n}</span>
        <h3 className="cp-title">{title}</h3>
        <span className="cp-word">{ok === true ? 'Confirmed' : ok === false ? 'Not confirmed' : 'No data'}</span>
      </div>
      <div className="cp-body">{children}</div>
    </li>
  );
}

function Kv({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="kv">
      <dt>{k}</dt>
      <dd className="mono">{children}</dd>
    </div>
  );
}

const yn = (v: boolean | undefined, yes = 'yes', no = 'no') => (v === true ? yes : v === false ? no : 'unknown');

export function RunRecordSection({ attempt }: { attempt: Attempt | null }) {
  const r = attempt?.rehearsal;
  if (!r) return <p className="notmeasured">No run record. No sandbox was started for this attempt.</p>;

  const host = r.host ?? {};
  const guest = r.guest ?? {};
  const probes = r.probes ?? {};
  const targets = probes.targets ?? [];
  const teardown = r.teardown ?? {};
  const statements = (r.result?.steps ?? []).flatMap((s) => (s.statements ?? []).map((st) => ({ step: s.step, ...st })));
  // A Linux host reports per shell step rather than per statement.
  const shellSteps = (r.result?.steps ?? []).filter((s) => !s.statements);
  const planSteps = attempt?.plan?.steps ?? [];
  const limits = r.limits ?? {};
  const scan = r.secret_scan ?? {};
  const metrics = r.metrics ?? {};

  const hostReady = r.host ? !!host.kvm_device && !!host.kvm_rw && !!r.image?.digest : undefined;
  const identity = r.guest && r.host ? !!guest.kernel && !!host.kernel && guest.kernel !== host.kernel && guest.hostname !== host.hostname : undefined;
  const allBlocked = probes.ok === true && targets.every((t) => t.result === 'BLOCKED');

  return (
    <>
      <p className="record-sum">
        <Tag tone={r.contained ? 'good' : 'bad'}>{r.contained ? 'Contained' : 'NOT contained'}</Tag> {attempt?.reproduced ? 'Six' : 'Five'} checkpoints, written by the host, not by the agent.
      </p>
      <ol className="cps">
        <Checkpoint n={1} title="Host ready" ok={hostReady}>
          <dl className="kvs">
            <Kv k="/dev/kvm">{yn(host.kvm_device, 'present', 'missing')}, {yn(host.kvm_rw, 'read and write', 'not writable')}</Kv>
            <Kv k="Image">{r.image?.reference ?? 'unknown'}</Kv>
            <Kv k="Digest">{r.image?.digest ?? 'unknown'}</Kv>
          </dl>
        </Checkpoint>

        <Checkpoint n={2} title="Sandbox identity" ok={identity}>
          <div className="scroll-x">
            <table className="data data-tight">
              <thead>
                <tr>
                  <th scope="col"></th>
                  <th scope="col">Kernel</th>
                  <th scope="col">Hostname</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Guest</th>
                  <td className="mono">{guest.kernel ?? 'unknown'}</td>
                  <td className="mono">{guest.hostname ?? 'unknown'}</td>
                </tr>
                <tr>
                  <th scope="row">Host</th>
                  <td className="mono">{host.kernel ?? 'unknown'}</td>
                  <td className="mono">{host.hostname ?? 'unknown'}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Checkpoint>

        <Checkpoint n={3} title="Isolation probes blocked" ok={r.probes ? allBlocked : undefined}>
          <div className="scroll-x">
            <table className="data data-tight">
              <thead>
                <tr>
                  <th scope="col">Target</th>
                  <th scope="col">Address</th>
                  <th scope="col">Result</th>
                  <th scope="col">How</th>
                </tr>
              </thead>
              <tbody>
                {targets.map((t, i) => (
                  <tr key={i}>
                    <th scope="row">{t.label}</th>
                    <td className="mono nowrap">{t.host}:{t.port}</td>
                    <td className="mono nowrap"><span className={t.result === 'BLOCKED' ? 'tone-good-text' : 'tone-bad-text'}>{t.result}</span></td>
                    <td className="mono">{t.how}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="kvs">
            <Kv k="NICs in the guest">{(probes.nics ?? []).join(', ') || 'none'}</Kv>
            <Kv k="Routes">{num(probes.routes)}</Kv>
            <Kv k="DNS">{probes.dns ?? 'unknown'}</Kv>
          </dl>
        </Checkpoint>

        <Checkpoint n={4} title="Rehearsal executed" ok={r.result ? r.result.ok === true : undefined}>
          {statements.length > 0 && (
            <div className="scroll-x">
              <table className="data data-tight">
                <thead>
                  <tr>
                    <th scope="col">Step</th>
                    <th scope="col">Statement</th>
                    <th scope="col">Tag</th>
                    <th scope="col" className="num">Rows</th>
                    <th scope="col" className="num">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {statements.map((s, i) => (
                    <tr key={i}>
                      <td className="mono">{num(s.step)}</td>
                      <td className="mono stmt" title={s.sql}>{s.sql}</td>
                      <td className="mono nowrap">
                        <span className={s.ok === false ? 'tone-bad-text' : undefined}>{s.tag ?? (s.ok === false ? 'failed' : 'no tag')}</span>
                      </td>
                      <td className="mono num">{num(s.rowcount)}</td>
                      <td className="mono num nowrap">{ms(s.ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {shellSteps.length > 0 && (
            <div className="scroll-x">
              <table className="data data-tight">
                <thead>
                  <tr>
                    <th scope="col">Step</th>
                    <th scope="col">Command</th>
                    <th scope="col" className="num">Exit</th>
                    <th scope="col" className="num">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {shellSteps.map((s, i) => {
                    const cmd = planSteps[(s.step ?? i + 1) - 1]?.cmd;
                    return (
                      <tr key={i}>
                        <td className="mono">{num(s.step)}</td>
                        <td className="mono stmt" title={cmd}>{cmd}</td>
                        <td className="mono num"><span className={s.exit_code ? 'tone-bad-text' : undefined}>{num(s.exit_code)}</span></td>
                        <td className="mono num nowrap">{ms(s.ms)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {r.result?.error && <p className="guardrail-error mono">{r.result.error}</p>}
        </Checkpoint>

        <Checkpoint n={5} title="Teardown confirmed" ok={r.teardown ? teardown.ok === true : undefined}>
          <dl className="kvs">
            <Kv k="Sandbox listed">{yn(teardown.sandbox_listed, 'still listed', 'not listed')}</Kv>
            <Kv k="Clone disk">{yn(teardown.rootfs_exists, 'still on disk', 'deleted')}</Kv>
            <Kv k="Leftover processes">{num(teardown.leftover_processes)}</Kv>
          </dl>
        </Checkpoint>

        {attempt?.reproduced ? (
          <Checkpoint n={6} title={attempt.reproduced.ok ? 'Reproduced on a second clone' : 'Did not reproduce on a second clone'} ok={attempt.reproduced.ok === true}>
            {attempt.reproduced.ok ? (
              <p>A second microVM ran the same plan on a new clone and measured the same counts, schema and content.</p>
            ) : (
              <>
                <p>A second microVM ran the same plan and got a different result, so this plan is likely to roll back at apply.</p>
                <dl className="kvs">
                  <Kv k="What differed">{(attempt.reproduced.differs ?? []).join(', ') || 'not listed'}</Kv>
                </dl>
              </>
            )}
            <dl className="kvs">
              <Kv k="Sandbox">{attempt.reproduced.sandbox ?? 'unknown'}</Kv>
              <Kv k="Took">{ms(attempt.reproduced.ms)}</Kv>
              <Kv k="Contained">{yn(attempt.reproduced.contained)}</Kv>
            </dl>
          </Checkpoint>
        ) : (
          <li className="cp is-neutral cp-skipped">
            <div className="cp-head">
              <span className="mono cp-n">6</span>
              <h3 className="cp-title">Second clone</h3>
              <span className="cp-word">Not run</span>
            </div>
            <div className="cp-body">
              <p className="muted">It only runs when a plan passes every guardrail and changed something.</p>
            </div>
          </li>
        )}
      </ol>

      <dl className="kvs kvs-inline record-extra">
        <Kv k="Limits">
          {num(limits.cpus)} CPUs, {num(limits.memory_mib)} MiB, {num(limits.max_duration_s)} s cap, network {plainNetwork(limits.network ?? 'unknown')}
        </Kv>
        <Kv k="Secret scan">
          <span className={scan.ok === false ? 'tone-bad-text' : undefined}>
            {num(scan.scanned)} items scanned, {num(scan.hits?.length ?? 0)} hits
          </span>
        </Kv>
        {metrics.memory_bytes !== undefined && (
          <Kv k="Guest memory">{bytes(metrics.memory_bytes)} of {bytes(metrics.memory_limit_bytes)}</Kv>
        )}
        {metrics.net_rx_bytes !== undefined && (
          <Kv k="Guest network">{bytes(metrics.net_rx_bytes)} in, {bytes(metrics.net_tx_bytes)} out</Kv>
        )}
        {r.boot_state && <Kv k="Guest systemd state">{r.boot_state}</Kv>}
        <Kv k="Total">{ms(r.phases?.total_ms)}</Kv>
      </dl>
    </>
  );
}

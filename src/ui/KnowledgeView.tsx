import React, { useEffect, useState } from 'react';
import { KnowledgeRule } from '../domain/types';
import { storage } from '../storage/local';
import { adoptionRate, distill } from '../learning/learning';
import { S } from './styles';

/**
 * Knowledge — the visible, editable experience base. Rules the system has
 * learned from feedback; humans prune what it learned wrong. This
 * inspectability is what keeps the learning loop trustworthy.
 */
export default function KnowledgeView() {
    const [rules, setRules] = useState<KnowledgeRule[]>([]);
    const [signals, setSignals] = useState(0);
    const [pending, setPending] = useState(0);
    const [adoption, setAdoption] = useState({ adopted: 0, total: 0, rate: 0 });
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState('');

    const refresh = async () => {
        setRules(await storage.listRules());
        const all = await storage.listSignals();
        setSignals(all.length);
        setPending(all.filter(s => !s.distilled).length);
        setAdoption(await adoptionRate());
    };
    useEffect(() => { refresh(); }, []);

    const toggleRule = async (rule: KnowledgeRule) => {
        await storage.upsertRule({ ...rule, enabled: !rule.enabled, updatedAt: Date.now() });
        refresh();
    };
    const deleteRule = async (rule: KnowledgeRule) => {
        if (!window.confirm(`Delete this rule?\n\n"${rule.rule}"`)) return;
        await storage.deleteRule(rule.id);
        refresh();
    };
    const runDistill = async () => {
        setBusy(true);
        setMsg('Distilling… (5–15s)');
        try {
            const r = await distill();
            setMsg(`Distilled ${r.newRules} new rule${r.newRules === 1 ? '' : 's'} from ${r.consumed} signals`);
        } catch (err: any) {
            setMsg(`❌ ${err?.message || err}`);
        } finally {
            setBusy(false);
            refresh();
        }
    };

    const scopeText = (r: KnowledgeRule) =>
        [r.scope.outputType, r.scope.purpose, r.scope.room, r.scope.category].filter(Boolean).join(' · ') || 'all';

    return (
        <div style={{ maxWidth: 860, margin: '0 auto', padding: '22px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                <Metric label="Adoption rate (north star)" value={`${(adoption.rate * 100).toFixed(0)}%`} sub={`${adoption.adopted} adopted / ${adoption.total} generated`} />
                <Metric label="Learned rules" value={String(rules.length)} sub={`${rules.filter(r => r.enabled).length} active`} />
                <Metric label="Feedback signals" value={String(signals)} sub={`${pending} awaiting distillation`} />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={S.label}>Rules — injected into prompts when scope matches</span>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {msg && <span style={{ fontSize: 11, color: '#059669' }}>{msg}</span>}
                    <button style={{ ...S.btn, opacity: busy || pending === 0 ? 0.4 : 1 }} disabled={busy || pending === 0} onClick={runDistill}>
                        Distill now
                    </button>
                </span>
            </div>

            {rules.length === 0 && (
                <div style={{ ...S.card, fontSize: 12, color: '#a1a1aa' }}>
                    No rules yet. Rate generations in Create (especially dislikes with reasons) and distill.
                </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {rules.map(rule => (
                    <div key={rule.id} style={{ ...S.card, display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', opacity: rule.enabled ? 1 : 0.5 }}>
                        <span style={{
                            fontSize: 9, fontWeight: 800, letterSpacing: 1, padding: '3px 8px', borderRadius: 999, flexShrink: 0,
                            background: rule.polarity === 'must' ? '#ecfdf5' : '#fef2f2',
                            color: rule.polarity === 'must' ? '#047857' : '#b91c1c',
                        }}>
                            {rule.polarity.toUpperCase()}
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{rule.rule}</span>
                            <span style={{ fontSize: 10, color: '#a1a1aa' }}>scope: {scopeText(rule)} · evidence: {rule.confidence} signal{rule.confidence === 1 ? '' : 's'}</span>
                        </span>
                        <button style={S.btnGhost} onClick={() => toggleRule(rule)}>{rule.enabled ? 'Disable' : 'Enable'}</button>
                        <button style={{ ...S.btnGhost, color: '#b91c1c' }} onClick={() => deleteRule(rule)}>Delete</button>
                    </div>
                ))}
            </div>
        </div>
    );
}

const Metric: React.FC<{ label: string; value: string; sub: string }> = ({ label, value, sub }) => (
    <div style={{ background: '#f4f4f5', borderRadius: 12, padding: '12px 16px' }}>
        <div style={{ fontSize: 11, color: '#71717a' }}>{label}</div>
        <div style={{ fontSize: 24, fontWeight: 600, margin: '2px 0' }}>{value}</div>
        <div style={{ fontSize: 10, color: '#a1a1aa' }}>{sub}</div>
    </div>
);

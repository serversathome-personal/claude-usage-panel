// Run with: node --test test/parse.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { labelFor, normalizeUsage, pickOrg } from '../parse.js';

const fixture = name => JSON.parse(readFileSync(
    new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const win = (utilization, resets_at = '2026-10-25T00:00:00Z') =>
    ({ utilization, resets_at });

test('labels model families, codenames and versions', () => {
    assert.deepEqual(labelFor('seven_day_opus'), { name: 'Opus', kind: 'model' });
    assert.deepEqual(labelFor('seven_day_omelette'), { name: 'Fable', kind: 'model' });
    assert.deepEqual(labelFor('Fable'), { name: 'Fable', kind: 'model' });
    assert.deepEqual(labelFor('opus_5_5'), { name: 'Opus 5.5', kind: 'model' });
    assert.deepEqual(labelFor('Claude Sonnet 5.5'), { name: 'Sonnet 5.5', kind: 'model' });
    assert.deepEqual(labelFor('seven_day_oauth_apps'), { name: 'OAuth apps', kind: 'other' });
});

test('October 2026 response: Fable cap comes from limits[]', () => {
    const out = normalizeUsage(fixture('usage-2026-10.json'));
    assert.equal(out.five_hour.pct, 37);
    assert.equal(out.seven_day.pct, 7);
    assert.deepEqual(out.limits.map(l => [l.name, l.kind, l.window, l.pct]),
        [['Fable', 'model', '7d', 9]]);
    assert.equal(out.limits[0].resets_at, '2026-10-26T15:00:00.260415+00:00');
});

test('October 2026 response: codename keys and null legacy keys are hidden', () => {
    const names = normalizeUsage(fixture('usage-2026-10.json')).limits.map(l => l.name);
    assert.equal(names.some(n => /iguana|tangelo|limits|opus|sonnet|cowork/i.test(n)), false);
});

test('October 2026 response: credits and weekly breakdown', () => {
    const out = normalizeUsage(fixture('usage-2026-10.json'));
    assert.deepEqual(out.credits, {
        enabled: false, used: 0, limit: 1, currency: 'USD', pct: 0,
        disabled_reason: 'out_of_credits',
    });
    assert.deepEqual(out.breakdown.map(r => [r.name, r.pct]),
        [['Claude Code', 87], ['Chats', 9], ['Cowork', 4], ['Other', 0]]);
});

test('older flat layout still works', () => {
    const out = normalizeUsage({
        five_hour: win(29),
        seven_day: win(6),
        seven_day_opus: win(30),
        seven_day_sonnet: null,
        extra_usage: { is_enabled: true, used_credits: 2500, monthly_limit: 2000, utilization: 100, currency: 'USD' },
    });
    assert.deepEqual(out.limits.map(l => [l.name, l.window, l.pct]), [['Opus', '7d', 30]]);
    assert.equal(out.credits.used, 25);
    assert.equal(out.credits.pct, 125);
});

test('overall windows fall back to limits[] if legacy keys disappear', () => {
    const out = normalizeUsage({
        limits: [
            { kind: 'session', group: 'session', percent: 12, resets_at: 'a' },
            { kind: 'weekly_all', group: 'weekly', percent: 40, resets_at: 'b' },
        ],
    });
    assert.equal(out.five_hour.pct, 12);
    assert.equal(out.seven_day.pct, 40);
    assert.deepEqual(out.limits, []);
});

test('surface-scoped limits are listed as other', () => {
    const out = normalizeUsage({
        limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 20, scope: { model: null, surface: { display_name: 'Claude Code' } } }],
    });
    assert.deepEqual(out.limits.map(l => [l.name, l.kind]), [['Claude Code', 'other']]);
});

test('pickOrg prefers lastActiveOrg, then chat orgs', () => {
    const api = { uuid: 'a', capabilities: ['api'] };
    const chat = { uuid: 'b', capabilities: ['chat', 'claude_max'] };
    assert.equal(pickOrg([api, chat], '').uuid, 'b');
    assert.equal(pickOrg([api, chat], 'a').uuid, 'a');
    assert.equal(pickOrg([api, chat], 'zzz').uuid, 'b');
    assert.equal(pickOrg([], ''), null);
});

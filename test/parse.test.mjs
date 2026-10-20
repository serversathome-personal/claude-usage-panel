// Run with: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { labelFor, normalizeUsage, pickOrg } from '../parse.js';

const win = (utilization, resets_at = '2026-10-25T00:00:00Z') =>
    ({ utilization, resets_at });

test('labels model families, codenames and versions', () => {
    assert.deepEqual(labelFor('seven_day_opus'), { name: 'Opus', kind: 'model' });
    assert.deepEqual(labelFor('seven_day_omelette'), { name: 'Fable', kind: 'model' });
    assert.deepEqual(labelFor('seven_day_fable'), { name: 'Fable', kind: 'model' });
    assert.deepEqual(labelFor('opus_5_5'), { name: 'Opus 5.5', kind: 'model' });
    assert.deepEqual(labelFor('claude-sonnet-5-5'), { name: 'Sonnet 5.5', kind: 'model' });
    assert.deepEqual(labelFor('seven_day_oauth_apps'), { name: 'OAuth apps', kind: 'other' });
    assert.deepEqual(labelFor('seven_day_cowork'), { name: 'Cowork', kind: 'other' });
    assert.deepEqual(labelFor('seven_day_iguana_necktie'), { name: 'Iguana necktie', kind: 'other' });
});

test('flat layout with null per-model keys', () => {
    const out = normalizeUsage({
        five_hour: win(29),
        seven_day: win(6),
        seven_day_opus: null,
        seven_day_sonnet: win(4),
        seven_day_fable: win(12),
        seven_day_oauth_apps: null,
        iguana_necktie: null,
        extra_usage: { is_enabled: false },
    });
    assert.equal(out.five_hour.pct, 29);
    assert.equal(out.seven_day.pct, 6);
    const byName = Object.fromEntries(out.limits.map(l => [l.name, l]));
    assert.equal(byName.Fable.pct, 12);
    assert.equal(byName.Fable.window, '7d');
    assert.equal(byName.Sonnet.pct, 4);
    assert.equal(byName.Opus.unused, true);
    assert.equal(byName['OAuth apps'].kind, 'other');
    // Null keys without a window prefix are not limits.
    assert.equal(out.limits.some(l => /iguana/i.test(l.name)), false);
});

test('nested object and array layouts', () => {
    const out = normalizeUsage({
        five_hour: win(10),
        seven_day: win(20),
        seven_day_models: { opus: win(30), fable: { used_percentage: 55, resets_at: 1792800000 } },
        limits: [
            { model: 'claude-haiku-5-5', window: 'five_hour', utilization: 3 },
        ],
    });
    const byName = Object.fromEntries(out.limits.map(l => [l.name, l]));
    assert.equal(byName.Opus.pct, 30);
    assert.equal(byName.Opus.window, '7d');
    assert.equal(byName.Fable.pct, 55);
    assert.match(byName.Fable.resets_at, /^\d{4}-\d\d-\d\dT/);
    assert.equal(byName['Haiku 5.5'].pct, 3);
    assert.equal(byName['Haiku 5.5'].window, '5h');
});

test('extra usage converts cents and recomputes percent', () => {
    const out = normalizeUsage({
        extra_usage: { is_enabled: true, used_credits: 2500, monthly_limit: 2000, utilization: 100, currency: 'USD' },
    });
    assert.equal(out.extra_usage.used_credits, 25);
    assert.equal(out.extra_usage.pct, 125);
});

test('pickOrg prefers lastActiveOrg, then chat orgs', () => {
    const api = { uuid: 'a', capabilities: ['api'] };
    const chat = { uuid: 'b', capabilities: ['chat', 'claude_max'] };
    assert.equal(pickOrg([api, chat], '').uuid, 'b');
    assert.equal(pickOrg([api, chat], 'a').uuid, 'a');
    assert.equal(pickOrg([api, chat], 'zzz').uuid, 'b');
    assert.equal(pickOrg([], ''), null);
});

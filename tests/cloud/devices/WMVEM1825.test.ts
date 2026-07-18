import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WMVEM1825'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'WMVEM1825'
const META: Metadata = { modelId: MODEL_ID, modelName: 'WMVEM1825', swVersion: '1.0' }

// Real captures from the live appliance (LG MVEM1825F). 41-family AABB, 46-byte status block.
const DOOR_OPEN = buf('AA0041B2000F070A01030000000197BB')
const DOOR_CLOSE = buf('AA0041B2000F070A01030000000094BB')
// 41EC (prev)(cur). Light action: cur block byte[36]=0x20 => light high / fan off.
const LIGHT_HIGH_FAN_OFF = buf(
    'AA6241EC003000015500000000000000FF030D000000000000000000000000000000C3000000004300008080808001000000003000015500000000000000FF030D000000000000000000000000000000C3000000004320008080808001000000C4BB',
)
// Fan action: cur block byte[36]=0x12 => light low / fan high.
const LIGHT_LOW_FAN_HIGH = buf(
    'AA6241EC003000015500000000000000FF030D000000000000000000000000000000C3000000004310008080808001000000003000015500000000000000FF030D000000000000000000000000000000C3000000004312008080808001000000C6BB',
)
// Cooking, remaining 1:30 (byte[0]=2, [16]:[17]=1:30).
const COOK_START_130 = buf(
    'AA6241EC073000004001000000000000FF030D000000000000000000000000000000C3000100004310008080808001000000023000004401000000000A00FF030D00011E00011E000000000000000000C700010000431001808080800100000096BB',
)
// Cooking, remaining 0:59 (31s later).
const COOK_059 = buf(
    'AA6241EC023000004401000000000A00FF030D00011E00011E000000000000000000C7000100004310018080808001000000023000004401000000000A00FF030D00003B00011E000000000000000000C70001000043100180808080010000007EBB',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config is published immediately (no unit gate)', () => {
        const { ha } = makeDevice()
        const dev = ha.devices[DEVICE_ID]
        assert.ok(dev?.config, 'config published')
        const c = dev.config!.components as Record<string, unknown>
        for (const k of ['door', 'cooking', 'light', 'vent_fan', 'time_remaining']) assert.ok(c[k], `${k} present`)
    })

    test('41B2 door event open/close', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'ON')
        thinq.emit('data', DOOR_CLOSE)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'OFF')
    })

    test('byte[36] nibbles: light high / fan off', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', LIGHT_HIGH_FAN_OFF)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.light, 'high')
        assert.equal(p.vent_fan, 'off')
        assert.equal(p.cooking, 'OFF')
    })

    test('byte[36] nibbles: light low / fan high', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', LIGHT_LOW_FAN_HIGH)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.light, 'low')
        assert.equal(p.vent_fan, 'high')
    })

    test('cooking + time remaining (1:30 -> 0:59)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', COOK_START_130)
        let p = ha.devices[DEVICE_ID].properties
        assert.equal(p.cooking, 'ON')
        assert.equal(p.time_remaining, 90) // 1*60 + 30
        thinq.emit('data', COOK_059)
        p = ha.devices[DEVICE_ID].properties
        assert.equal(p.cooking, 'ON')
        assert.equal(p.time_remaining, 59) // 0*60 + 59
    })

    test('start() sends the F0ED status query', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        const q = thinq.outbox[0]
        // strip AA,len .. cksum,BB -> the query payload we intend to send
        assert.equal(hex(q.subarray(2, q.length - 2)), 'F0ED114101000000180E111718191A1A1B00000000000000')
        assert.equal(q[0], 0xaa)
        assert.equal(q[q.length - 1], 0xbb)
    })

    test('non-AABB frames are ignored', () => {
        const { thinq } = makeDevice()
        // constructor already published config; just ensure a junk frame does not throw
        assert.doesNotThrow(() => thinq.emit('data', buf('001122')))
    })
})

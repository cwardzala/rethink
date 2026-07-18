import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2REF11EIIDAS2'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '2REF11EIIDAS2'
const META: Metadata = { modelId: MODEL_ID, modelName: '2REF11EIIDAS2', swVersion: '1.0' }

// Real captures from the live appliance (LG 2REF11EIIDAS2, CLIP fw). STATUS_LENGTH = 18.
//   AA 0x18 10EB <18 status> <cksum> BB
//   AA 0x2A 10EC <18 prev> <18 cur> <cksum> BB
// Fahrenheit (status[8]=0). Fridge setpoint at status[1]: 0x08=36F, 0x0A=34F (44 - F).
const INITIAL_10EB = buf('AA1810EB0208060102020400000000FFFFFF00FFFF0187BB')
const STATUS_FRIDGE_36F = buf('AA2A10EC0208060102020400000000FFFFFF00FFFF010208060102020400000000FFFFFF00FFFF00ACBB')
const STATUS_FRIDGE_34F = buf('AA2A10EC0208060102020400000000FFFFFF00FFFF00020A060102020400000000FFFFFF00FFFF00AFBB')
// Real 10A8 per-door events: 10A8 <doorId 1=fridge/2=freezer> <1=open/0=closed>
const FRIDGE_DOOR_OPEN = buf('AA0810A8010139BB')
const FRIDGE_DOOR_CLOSE = buf('AA0810A801003EBB')
const FREEZER_DOOR_OPEN = buf('AA0810A8020138BB')
const FREEZER_DOOR_CLOSE = buf('AA0810A8020039BB')

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('no config until a status frame arrives', () => {
        const { ha } = makeDevice()
        assert.equal(ha.devices[DEVICE_ID], undefined)
    })

    test('10EB initial status: Fahrenheit config + decoded fields', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', INITIAL_10EB)

        const dev = ha.devices[DEVICE_ID]
        assert.ok(dev?.config, 'config published')
        const components = dev.config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.fridge_setpoint.unit_of_measurement, '°F')
        assert.equal(dev.properties.fridge_setpoint, 36) // 44 - 0x08
        assert.equal(dev.properties.freezer_setpoint, 0) // 6 - 0x06
        assert.equal(dev.properties.door, 'OFF') // seeded closed
        assert.equal(dev.properties.freezer_door, 'OFF') // seeded closed
        assert.equal(dev.properties.express_freeze, 'OFF') // status[3] = 1
    })

    test('10A8 per-door events drive fridge + freezer door sensors independently', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', INITIAL_10EB) // publishes config + seeds both doors OFF
        const p = () => ha.devices[DEVICE_ID].properties

        thinq.emit('data', FRIDGE_DOOR_OPEN)
        assert.equal(p().door, 'ON')
        assert.equal(p().freezer_door, 'OFF')

        thinq.emit('data', FREEZER_DOOR_OPEN)
        assert.equal(p().door, 'ON')
        assert.equal(p().freezer_door, 'ON')

        thinq.emit('data', FRIDGE_DOOR_CLOSE)
        assert.equal(p().door, 'OFF')
        assert.equal(p().freezer_door, 'ON')

        thinq.emit('data', FREEZER_DOOR_CLOSE)
        assert.equal(p().freezer_door, 'OFF')
    })

    test('10EC current block decodes fridge setpoint 34F', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATUS_FRIDGE_34F)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 34) // 44 - 0x0A
    })

    test('10EC prev/cur: current block wins (36F sample)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATUS_FRIDGE_36F)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 36)
    })

    test('start() emits the F0ED status query', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), 'AA0EF0ED1211010000010400EBBB')
    })

    test('HA write fridge_setpoint=34F -> F017 status[1]=0x0A', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', INITIAL_10EB) // unit <- F
        thinq.resetRecorder()
        dev.setProperty('fridge_setpoint', '34')
        const pkt = thinq.outbox[0]
        assert.equal(pkt[2], 0xf0)
        assert.equal(pkt[3], 0x17)
        assert.equal(pkt[4 + 1], 0x0a) // 44 - 34
        assert.equal(pkt[4 + 8], 0) // tempUnit = F
    })

    test('HA write express_freeze ON -> status[3]=0x02', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', INITIAL_10EB)
        thinq.resetRecorder()
        dev.setProperty('express_freeze', 'ON')
        assert.equal(thinq.outbox[0][4 + 3], 0x02)
    })

    test('non-AABB frames are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('001122'))
        assert.equal(ha.devices[DEVICE_ID], undefined)
    })
})

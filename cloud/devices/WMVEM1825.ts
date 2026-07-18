import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

// LG WMVEM1825 (MVEM1825F) over-the-range microwave, CLIP+BLE firmware (deviceType 302).
// Uses a `41`-family AABB protocol (vs the fridges' `10` family). Read-only monitoring:
// we deliberately do NOT implement cook start/controls — the appliance's safety interlock
// requires a human present, and rethink's guidelines forbid circumventing it.
//
// Status block = 46 bytes. Field mapping confirmed live against the appliance:
//   [0]  cook status: 0=idle, 2=cooking (5/7 seen transiently)
//   [16]:[17]  time REMAINING (minutes:seconds, counts down)
//   [19]:[20]  time SET (minutes:seconds)
//   [36]  = (light << 4) | vent_fan, each nibble 0=off / 1=low / 2=high
// Door is reported by a separate short `41B2` event packet (last byte 1=open / 0=closed).
const STATUS_LENGTH = 46
const LEVELS = ['off', 'low', 'high'] as const
const level = (nibble: number) => LEVELS[nibble] ?? `unknown(${nibble})`

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Microwave' }),
                components: {
                    door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                    },
                    cooking: {
                        platform: 'binary_sensor',
                        device_class: 'running',
                        unique_id: '$deviceid-cooking',
                        state_topic: '$this/cooking',
                        name: 'Cooking',
                    },
                    light: {
                        platform: 'sensor',
                        unique_id: '$deviceid-light',
                        state_topic: '$this/light',
                        name: 'Light',
                        icon: 'mdi:lightbulb',
                    },
                    vent_fan: {
                        platform: 'sensor',
                        unique_id: '$deviceid-vent_fan',
                        state_topic: '$this/vent_fan',
                        name: 'Vent Fan',
                        icon: 'mdi:fan',
                    },
                    time_remaining: {
                        platform: 'sensor',
                        device_class: 'duration',
                        unit_of_measurement: 's',
                        unique_id: '$deviceid-time_remaining',
                        state_topic: '$this/time_remaining',
                        name: 'Time Remaining',
                        icon: 'mdi:timer',
                    },
                },
            }),
        )
    }

    start() {
        // Ask the microwave to report status (byte-identical to LG's own query).
        this.send(Buffer.from('F0ED114101000000180E111718191A1A1B00000000000000', 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf[0] === 0x41 && buf[1] === 0xeb && buf.length >= 2 + STATUS_LENGTH) {
            this.processStatus(buf.subarray(2, 2 + STATUS_LENGTH))
        } else if (buf[0] === 0x41 && buf[1] === 0xec && buf.length >= 2 + STATUS_LENGTH * 2) {
            // 41EC = (prev)(cur) — take the current block
            this.processStatus(buf.subarray(2 + STATUS_LENGTH, 2 + STATUS_LENGTH * 2))
        } else if (buf[0] === 0x41 && buf[1] === 0xb2 && buf.length === 12) {
            // short 41B2 door event; long 41B2 variants are cook-start/end logs (ignored)
            this.publishProperty('door', buf[11] === 1 ? 'ON' : 'OFF')
        }
    }

    processStatus(s: Buffer) {
        this.publishProperty('cooking', s[0] === 2 ? 'ON' : 'OFF')
        this.publishProperty('light', level(s[36] >> 4))
        this.publishProperty('vent_fan', level(s[36] & 0x0f))
        // Remaining time as total seconds (updates on 41EC transitions, not per-second).
        this.publishProperty('time_remaining', s[16] * 60 + s[17])
    }
}

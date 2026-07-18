import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import {
    convertFridgeTemperature,
    convertFreezerTemperature,
    fridgeRange,
    freezerRange,
    packStatus,
    Status,
    TemperatureUnit,
    unpackStatus,
} from './fridge_common'

// LG 2REF11EIIDAS2 French-door refrigerator, CLIP firmware (protocolVer 7, RTL8711am).
// Same F0ED->10EB/10EC status protocol and shared fridge STATUS_FIELDS map as the other
// 2REF11 fridges, but with an 18-byte (truncated) status block. Field mapping confirmed
// live against the appliance:
//   fridge 36F -> status[1]=0x08, 34F -> 0x0A   (44 - F, the standard fridge_common encoding)
//   status[8]=0 -> Fahrenheit;  status[7] -> any door open;  status[2] -> freezer setpoint
const STATUS_LENGTH = 18

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery
    temperatureUnit: TemperatureUnit | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.deviceConfig = HADevice.config(meta, { name: 'LG Fridge' })
        // HomeAssistant config is published once we learn the temperature unit.
    }

    setTemperatureUnit(unit: TemperatureUnit) {
        if (this.temperatureUnit === unit) return
        this.temperatureUnit = unit
        this.setConfig(
            allowExtendedType({
                ...this.deviceConfig,
                components: {
                    fridge_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-fridge_setpoint',
                        state_topic: '$this/fridge_setpoint',
                        command_topic: '$this/fridge_setpoint/set',
                        name: 'Fridge temperature',
                        ...fridgeRange(unit),
                    },
                    freezer_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-freezer_setpoint',
                        state_topic: '$this/freezer_setpoint',
                        command_topic: '$this/freezer_setpoint/set',
                        name: 'Freezer temperature',
                        ...freezerRange(unit),
                    },
                    express_freeze: {
                        platform: 'switch',
                        unique_id: '$deviceid-express_freeze',
                        state_topic: '$this/express_freeze',
                        command_topic: '$this/express_freeze/set',
                        icon: 'mdi:snowflake',
                        name: 'Express Freeze',
                    },
                    door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Fridge Door',
                    },
                    freezer_door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-freezer_door',
                        state_topic: '$this/freezer_door',
                        name: 'Freezer Door',
                    },
                },
            }),
        )
        // The per-door state comes from 10A8 events (sent only on change), so seed
        // both closed until the appliance reports otherwise.
        this.publishProperty('door', 'OFF')
        this.publishProperty('freezer_door', 'OFF')
    }

    start() {
        // Ask the fridge to report status (same query LG's cloud issues).
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf.length === 2 + STATUS_LENGTH * 2 && buf[0] == 0x10 && buf[1] == 0xec) {
            // 10EC = (prev status)(cur status) — take the current one
            this.processStatus(buf.subarray(2 + STATUS_LENGTH, 2 + STATUS_LENGTH * 2))
        }
        if (buf.length === 2 + STATUS_LENGTH && buf[0] == 0x10 && buf[1] == 0xeb) {
            // 10EB = initial status
            this.processStatus(buf.subarray(2, 2 + STATUS_LENGTH))
        }
        if (buf.length === 4 && buf[0] == 0x10 && buf[1] == 0xa8) {
            // 10A8 <doorId> <state> — per-door open/close event (id 1=fridge, 2=freezer)
            const state = buf[3] === 1 ? 'ON' : 'OFF'
            if (buf[2] === 1) this.publishProperty('door', state)
            else if (buf[2] === 2) this.publishProperty('freezer_door', state)
        }
    }

    processStatus(curStatus: Buffer) {
        const s = unpackStatus(curStatus)
        this.setTemperatureUnit(s.tempUnit ? 'C' : 'F')
        // NOTE: status[7] is an aggregate "any door open" flag, not per-door — the
        // per-door sensors are driven by the 10A8 events in processAABB instead.
        this.publishProperty('fridge_setpoint', convertFridgeTemperature(this.temperatureUnit!, s.fridgeSetpoint))
        this.publishProperty('freezer_setpoint', convertFreezerTemperature(this.temperatureUnit!, s.freezerSetpoint))
        this.publishProperty('express_freeze', s.expressFreeze === 2 ? 'ON' : 'OFF')
    }

    sendSetting(setting: Partial<Status>) {
        this.send(Buffer.concat([Buffer.from('F017', 'hex'), packStatus(setting, STATUS_LENGTH)]))
    }

    setProperty(prop: string, mqttValue: string) {
        const unit = this.temperatureUnit || 'F'
        const setting: Partial<Status> = { tempUnit: unit === 'C' ? 1 : 0 }

        if (prop === 'fridge_setpoint') {
            setting.fridgeSetpoint = convertFridgeTemperature(unit, Number(mqttValue))
            this.sendSetting(setting)
        } else if (prop === 'freezer_setpoint') {
            setting.freezerSetpoint = convertFreezerTemperature(unit, Number(mqttValue))
            this.sendSetting(setting)
        } else if (prop === 'express_freeze') {
            setting.expressFreeze = mqttValue === 'ON' ? 2 : 1
            this.sendSetting(setting)
        }
    }
}

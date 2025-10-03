// ===============================================================================
// Automata Nexus AI - DOAS Control Logic
// Neural Facility Intelligence Processing Infrastructure (PRODUCTION)
// ===============================================================================

/**
 * DOAS (Dedicated Outdoor Air System) Control Logic
 *
 * This module implements intelligent control algorithms for DOAS systems
 * including fan control, modulating gas valve heating, 2-stage DX cooling,
 * dehumidification control, and freeze protection.
 *
 * Equipment Configuration:
 * - 1 x Supply Fan with VFD (0-10V speed control)
 * - 1 x Modulating Gas Valve (0-10V control, 26-100%)
 * - 2 x DX Cooling Stages (Triac control)
 * - 1 x OA Damper (Triac control)
 * - 1 x Supply Air Temperature Sensor (10K NTC)
 *
 * Equipment ID: WBAuutoHnGUtAEc4w6SC
 * Location: Element Labs
 *
 * @module DoasLogic
 * @version 1.0.0
 * @author AutomataNexus - Element Labs
 * @date 2025-10-03
 */

// EQUIPMENT IDENTIFICATION
const EQUIPMENT_IDS = {
    DOAS_1: 'WBAuutoHnGUtAEc4w6SC'
};

// CONFIGURATION SECTION
const DOAS_CONFIG = {
    // Equipment identification
    EQUIPMENT_IDS: EQUIPMENT_IDS,
    LOCATION: 'Element Labs',

    // Temperature setpoints and thresholds (°F)
    DEFAULT_SETPOINT: 68.0,
    HEATING_THRESHOLD: 65.0,
    COOLING_THRESHOLD: 65.5,
    HIGH_TEMP_LIMIT: 115.0,
    LOW_TEMP_LIMIT: 40.0,
    HEATING_LOCKOUT_TEMP: 65.0,
    COOLING_LOCKOUT_TEMP: 50.0,
    FREEZE_PROTECTION_TEMP: 40.0,

    // Gas valve control (0-5V analog output)
    GAS_VALVE_MIN_VOLTAGE: 0.0,      // Minimum voltage (fully closed)
    GAS_VALVE_MAX_VOLTAGE: 5.0,      // Maximum voltage (fully open)
    GAS_VALVE_MIN_FIRE_VOLTAGE: 2.28, // Low fire voltage
    GAS_VALVE_MIN_FIRE_TIME: 3 * 60 * 1000, // Run at min fire for 3 minutes before modulating

    // DX cooling stages (°F above setpoint)
    DX_STAGE1_THRESHOLD: 2.0,
    DX_STAGE2_THRESHOLD: 7.0,

    // Dehumidification control
    DEHUM_OAT_THRESHOLD: 55.0,
    OUTDOOR_HUMIDITY_HIGH: 85.0,
    OUTDOOR_HUMIDITY_LOW: 83.0,
    INDOOR_HUMIDITY_HIGH: 55.0,
    INDOOR_HUMIDITY_LOW: 53.0,
    SPACE_TEMP_TOLERANCE: 3.0,

    // Timing delays (milliseconds)
    FREEZE_PROTECTION_TIME: 5 * 60 * 1000,
    FAN_STARTUP_DELAY: 15 * 1000,
    STAGE_MIN_RUN_TIME: 7 * 60 * 1000,
    STAGE_MIN_OFF_TIME: 5 * 60 * 1000,
    DX_FAILOVER_TIME_COOLING: 5 * 60 * 1000,
    DX_FAILOVER_TIME_DEHUM: 1 * 60 * 1000,
    DX_FAILOVER_TEMP_DROP: 5.0,

    // Occupancy schedule
    OCCUPIED_START_HOUR: 7,
    OCCUPIED_START_MINUTE: 0,
    OCCUPIED_END_HOUR: 21,
    OCCUPIED_END_MINUTE: 45,
    OCCUPANCY_BYPASS: true
};

/**
 * Helper to safely parse numbers from various sources
 */
function parseSafeNumber(value, defaultValue) {
    if (typeof value === 'number' && !isNaN(value)) {
        return value;
    }
    if (typeof value === 'string') {
        const parsed = parseFloat(value);
        if (!isNaN(parsed)) {
            return parsed;
        }
    }
    return defaultValue;
}

/**
 * Check if current time is within occupied hours or if bypass is active
 */
function isOccupiedTime() {
    if (DOAS_CONFIG.OCCUPANCY_BYPASS) {
        return true;
    }

    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentMinutes = (currentHour * 60) + currentMinute;
    const occupiedStartMinutes = (DOAS_CONFIG.OCCUPIED_START_HOUR * 60) + DOAS_CONFIG.OCCUPIED_START_MINUTE;
    const occupiedEndMinutes = (DOAS_CONFIG.OCCUPIED_END_HOUR * 60) + DOAS_CONFIG.OCCUPIED_END_MINUTE;

    return currentMinutes >= occupiedStartMinutes && currentMinutes <= occupiedEndMinutes;
}

/**
 * Calculate outdoor air damper position - DOAS FREEZE PROTECTION AND OCCUPANCY CONTROL
 */
function calculateOutdoorDamperPosition(supplyTemp, stateData, isOccupied) {
    // First check occupancy - close damper during unoccupied hours
    if (!isOccupied) {
        if (stateData.freezeProtectionStart) {
            delete stateData.freezeProtectionStart;
        }
        return 0; // CLOSED
    }

    // Check freeze protection during occupied hours
    if (supplyTemp < DOAS_CONFIG.FREEZE_PROTECTION_TEMP) {
        const now = Date.now();
        if (!stateData.freezeProtectionStart) {
            stateData.freezeProtectionStart = now;
        }

        const freezeTime = now - stateData.freezeProtectionStart;
        if (freezeTime >= DOAS_CONFIG.FREEZE_PROTECTION_TIME) {
            return 0; // CLOSED - freeze protection active
        } else {
            return 100; // OPEN - freeze protection countdown
        }
    } else {
        if (stateData.freezeProtectionStart) {
            delete stateData.freezeProtectionStart;
        }
        return 100; // OPEN - normal operation
    }
}

/**
 * Main DOAS control function
 *
 * Processes incoming sensor data and generates control commands for
 * DOAS systems with proper mode switching and safety interlocks.
 *
 * @param {Object} data - Sensor data from DOAS system
 * @param {Object} uiCommands - User interface commands and setpoints
 * @param {Object} stateStorage - Persistent state storage for timing and cycling
 * @returns {Object} Control commands for DOAS system
 */
function processDoasControl(data, uiCommands = {}, stateStorage = {}) {
    try {
        // Initialize state storage for freeze protection and DX failover
        // Use stateStorage parameter instead of file system
        let stateData = stateStorage || {};

        // Initialize control result object with MegaBas HAT specific names
        const controlResult = {
            // Equipment identification
            equipmentIds: EQUIPMENT_IDS,

            // MegaBas Building Automation HAT Outputs
            // Triacs T1-T4
            oaDamperFanEnable: false,    // T1 - OA Damper/Supply Fan Enable
            heatEnable: false,           // T2 - Heat Enable
            chillerStage1Enable: false,  // T3 - Chiller Enable Stage 1
            chillerStage2Enable: false,  // T4 - Chiller Enable Stage 2

            // Analog Outputs AO1-AO2
            supplyFanSpeed: 0,           // AO1: 0-10V speed reference
            gasValvePosition: 0,         // AO2: 0-5V gas valve control

            // System status
            systemEnabled: true,
            emergencyShutdown: false,
            shutdownReason: null,

            // Temperature readings
            supplyTemp: 0,
            spaceTemp: 0,
            outdoorTemp: 0,
            targetSetpoint: DOAS_CONFIG.DEFAULT_SETPOINT,

            // Humidity readings
            outdoorHumidity: 50,
            labRh: 50,

            // Control mode and status
            controlMode: 'unoccupied',
            isOccupied: false,
            heatingLockout: false,
            coolingLockout: false,
            dehumidificationMode: false,
            stage1FailoverActive: false,

            // Alarms and faults
            alarmStatus: 'normal',
            faultConditions: [],

            // Timestamps
            lastUpdate: new Date().toISOString(),
            controlTimestamp: Date.now()
        };

        // Extract temperature readings
        let supplyTemp = parseSafeNumber(data.AI4,
            parseSafeNumber(data.SupplyTemp,
            parseSafeNumber(data.Supply_Air_Temp,
            parseSafeNumber(data.SupplyAirTemp, 65))));

        const outdoorTemp = parseSafeNumber(data.Outdoor_Air,
            parseSafeNumber(data.OutdoorTemp,
            parseSafeNumber(data.OAT,
            parseSafeNumber(data.outdoorTemp, 65))));

        let spaceTemp = parseSafeNumber(data.AI2,
            parseSafeNumber(data.SpaceTemp,
            parseSafeNumber(data.Space,
            parseSafeNumber(data.RoomTemp, 70))));

        // SANITY CHECK: Temperature sensor range is -60°F to 300°F
        // Only check AI2 (space) and AI4 (supply) - outdoor temp comes from weather DB
        const TEMP_MIN = -60;
        const TEMP_MAX = 300;

        if (supplyTemp < TEMP_MIN || supplyTemp > TEMP_MAX) {
            console.log(`[Element DOAS] INVALID SUPPLY TEMP SENSOR: ${supplyTemp.toFixed(1)}°F (out of range -60 to 300°F) - using last known or default 65°F`);
            supplyTemp = this.lastOutputs?.supplyTemp || 65;
            controlResult.faultConditions.push('INVALID_SUPPLY_TEMP_SENSOR');
        }

        if (spaceTemp < TEMP_MIN || spaceTemp > TEMP_MAX) {
            console.log(`[Element DOAS] INVALID SPACE TEMP SENSOR: ${spaceTemp.toFixed(1)}°F (out of range -60 to 300°F) - using last known or default 70°F`);
            spaceTemp = this.lastOutputs?.spaceTemp || 70;
            controlResult.faultConditions.push('INVALID_SPACE_TEMP_SENSOR');
        }

        // Extract humidity readings
        const outdoorHumidity = parseSafeNumber(data.outdoorHumidity,
            parseSafeNumber(data.OutdoorHumidity,
            parseSafeNumber(data.OAH, 50)));

        const labRh = parseSafeNumber(data.labRh,
            parseSafeNumber(data.LabRH,
            parseSafeNumber(data.RoomRH, 50)));

        // Update control result with current readings
        controlResult.supplyTemp = parseFloat(supplyTemp.toFixed(1));
        controlResult.spaceTemp = parseFloat(spaceTemp.toFixed(1));
        controlResult.outdoorTemp = parseFloat(outdoorTemp.toFixed(1));
        controlResult.outdoorHumidity = parseFloat(outdoorHumidity.toFixed(1));
        controlResult.labRh = parseFloat(labRh.toFixed(1));

        // Check for UI setpoint override
        let targetSetpoint = parseSafeNumber(data.userSetpoint, DOAS_CONFIG.DEFAULT_SETPOINT);
        if (uiCommands.temperatureSetpoint !== undefined) {
            targetSetpoint = parseSafeNumber(uiCommands.temperatureSetpoint, targetSetpoint);
        } else if (uiCommands.waterTemperatureSetpoint !== undefined) {
            targetSetpoint = parseSafeNumber(uiCommands.waterTemperatureSetpoint, targetSetpoint);
        } else if (data.supplyAirSetpoint !== undefined) {
            targetSetpoint = parseSafeNumber(data.supplyAirSetpoint, targetSetpoint);
        }
        controlResult.targetSetpoint = parseFloat(targetSetpoint.toFixed(1));

        // SAFETY CHECKS - Temperature limits
        if (supplyTemp >= DOAS_CONFIG.HIGH_TEMP_LIMIT) {
            console.log(`[Element DOAS] HIGH TEMPERATURE LIMIT EXCEEDED: ${supplyTemp.toFixed(1)}°F >= ${DOAS_CONFIG.HIGH_TEMP_LIMIT}°F - EMERGENCY SHUTDOWN`);
            controlResult.systemEnabled = false;
            controlResult.emergencyShutdown = true;
            controlResult.shutdownReason = "High temperature limit exceeded";
            controlResult.alarmStatus = 'critical';
            controlResult.faultConditions.push('HIGH_TEMP_LIMIT_EXCEEDED');
            return controlResult;
        }

        // Low temperature limit with 5 minute delay
        if (supplyTemp <= DOAS_CONFIG.LOW_TEMP_LIMIT) {
            const now = Date.now();
            if (!stateData.lowTempStart) {
                stateData.lowTempStart = now;
                console.log(`[Element DOAS] LOW TEMPERATURE WARNING: ${supplyTemp.toFixed(1)}°F <= ${DOAS_CONFIG.LOW_TEMP_LIMIT}°F - Starting 5 minute timer`);
            }

            const lowTempTime = now - stateData.lowTempStart;
            if (lowTempTime >= DOAS_CONFIG.FREEZE_PROTECTION_TIME) {
                // If outdoor air is warm (>50°F), just disable cooling and let fan bring temp back up
                // If outdoor air is cold, shut down everything (fan would just pull in more cold air)
                if (outdoorTemp > DOAS_CONFIG.COOLING_LOCKOUT_TEMP) {
                    console.log(`[Element DOAS] LOW TEMPERATURE LIMIT EXCEEDED for 5 minutes: ${supplyTemp.toFixed(1)}°F - DISABLING COOLING (OAT=${outdoorTemp.toFixed(1)}°F is warm, keeping fan running)`);
                    controlResult.chillerStage1Enable = false;
                    controlResult.chillerStage2Enable = false;
                    controlResult.heatEnable = false;
                    controlResult.gasValvePosition = 0;
                    controlResult.alarmStatus = 'warning';
                    controlResult.faultConditions.push('LOW_TEMP_COOLING_DISABLED');
                    // Don't return - continue with fan running
                } else {
                    console.log(`[Element DOAS] LOW TEMPERATURE LIMIT EXCEEDED for 5 minutes: ${supplyTemp.toFixed(1)}°F - EMERGENCY SHUTDOWN (OAT=${outdoorTemp.toFixed(1)}°F is cold)`);
                    controlResult.systemEnabled = false;
                    controlResult.emergencyShutdown = true;
                    controlResult.shutdownReason = "Low temperature limit exceeded for 5 minutes with cold outdoor air";
                    controlResult.alarmStatus = 'critical';
                    controlResult.faultConditions.push('LOW_TEMP_LIMIT_EXCEEDED');
                    return controlResult;
                }
            }
        } else {
            if (stateData.lowTempStart) {
                delete stateData.lowTempStart;
                console.log(`[Element DOAS] Low temperature cleared`);
            }
        }

        // Check lockout conditions
        const heatingLockout = outdoorTemp > DOAS_CONFIG.HEATING_LOCKOUT_TEMP;
        const coolingLockout = outdoorTemp < DOAS_CONFIG.COOLING_LOCKOUT_TEMP;
        controlResult.heatingLockout = heatingLockout;
        controlResult.coolingLockout = coolingLockout;

        // Check occupancy status
        const isOccupied = isOccupiedTime();
        controlResult.isOccupied = isOccupied;

        // Calculate outdoor air damper position (freeze protection and occupancy control)
        const outdoorDamperPosition = calculateOutdoorDamperPosition(supplyTemp, stateData, isOccupied);
        const fanShouldBeEnabled = outdoorDamperPosition > 0;

        // Fan startup delay - wait 15 seconds after enabling fan before enabling heating/cooling
        const now = Date.now();
        let fanStartupComplete = true;

        if (fanShouldBeEnabled && !this.lastOutputs?.oaDamperFanEnable) {
            // Fan is being turned on
            if (!stateData.fanStartupTime) {
                stateData.fanStartupTime = now;
                console.log(`[Element DOAS] Fan starting - waiting 15 seconds for dampers to open`);
            }
            const fanStartupElapsed = now - stateData.fanStartupTime;
            fanStartupComplete = fanStartupElapsed >= DOAS_CONFIG.FAN_STARTUP_DELAY;
        } else if (!fanShouldBeEnabled) {
            // Fan is off, clear startup timer
            if (stateData.fanStartupTime) {
                delete stateData.fanStartupTime;
            }
        }

        controlResult.oaDamperFanEnable = fanShouldBeEnabled;

        // VFD speed: 10V when fan is on, 0V when fan is off
        controlResult.supplyFanSpeed = fanShouldBeEnabled ? 10.0 : 0;

        // Only operate heating/cooling during occupied hours and after fan startup delay
        if (isOccupied && fanStartupComplete) {
            controlResult.systemEnabled = true;

            // Check for dehumidification conditions
            const dehumidificationRequired = (
                outdoorTemp > DOAS_CONFIG.DEHUM_OAT_THRESHOLD &&
                (outdoorHumidity > DOAS_CONFIG.OUTDOOR_HUMIDITY_HIGH || labRh > DOAS_CONFIG.INDOOR_HUMIDITY_HIGH)
            );

            let inDehumidificationMode = stateData.dehumidificationMode || false;

            if (dehumidificationRequired && !inDehumidificationMode) {
                stateData.dehumidificationMode = true;
                inDehumidificationMode = true;
                console.log(`[Element DOAS] ENTERING DEHUMIDIFICATION MODE: OAT=${outdoorTemp.toFixed(1)}°F, OutdoorRH=${outdoorHumidity.toFixed(1)}%, LabRH=${labRh.toFixed(1)}%`);
            } else if (inDehumidificationMode) {
                const exitConditions = (
                    outdoorTemp <= DOAS_CONFIG.DEHUM_OAT_THRESHOLD ||
                    (outdoorHumidity < DOAS_CONFIG.OUTDOOR_HUMIDITY_LOW && labRh < DOAS_CONFIG.INDOOR_HUMIDITY_LOW)
                );

                if (exitConditions) {
                    stateData.dehumidificationMode = false;
                    inDehumidificationMode = false;
                    console.log(`[Element DOAS] EXITING DEHUMIDIFICATION MODE: Conditions no longer met`);
                }
            }

            controlResult.dehumidificationMode = inDehumidificationMode;

            // Control logic based on mode
            if (inDehumidificationMode) {
                controlResult.controlMode = 'dehumidification';

                const spaceError = spaceTemp - targetSetpoint;
                const allowHeating = spaceError <= DOAS_CONFIG.SPACE_TEMP_TOLERANCE;
                const allowCooling = spaceError >= -DOAS_CONFIG.SPACE_TEMP_TOLERANCE;

                if (allowCooling && !coolingLockout) {
                    // Enable Stage 1 cooling for dehumidification
                    controlResult.chillerStage1Enable = true;

                    // Add heating only if space allows it
                    if (allowHeating && !heatingLockout) {
                        controlResult.heatEnable = true;

                        // Track when heat was first enabled for min fire delay
                        const heatCurrentlyOn = this.lastOutputs?.heatEnable || false;
                        if (!heatCurrentlyOn) {
                            stateData.heatStartTime = now;
                            console.log(`[Element DOAS] Dehumidification heat starting - running at min fire (${DOAS_CONFIG.GAS_VALVE_MIN_FIRE_VOLTAGE}V) for 3 minutes`);
                        }

                        const heatOnElapsed = stateData.heatStartTime ? (now - stateData.heatStartTime) : 0;

                        if (heatOnElapsed < DOAS_CONFIG.GAS_VALVE_MIN_FIRE_TIME) {
                            // Still in 3-minute min fire period
                            controlResult.gasValvePosition = DOAS_CONFIG.GAS_VALVE_MIN_FIRE_VOLTAGE;
                        } else {
                            // After 3 minutes, modulate based on supply temperature error
                            const tempError = targetSetpoint - supplyTemp;
                            if (tempError > 0) {
                                const voltageRange = DOAS_CONFIG.GAS_VALVE_MAX_VOLTAGE - DOAS_CONFIG.GAS_VALVE_MIN_FIRE_VOLTAGE;
                                const calculatedVoltage = DOAS_CONFIG.GAS_VALVE_MIN_FIRE_VOLTAGE + (tempError * (voltageRange / 10));
                                controlResult.gasValvePosition = Math.min(DOAS_CONFIG.GAS_VALVE_MAX_VOLTAGE,
                                    Math.max(DOAS_CONFIG.GAS_VALVE_MIN_FIRE_VOLTAGE, calculatedVoltage));
                            } else {
                                controlResult.gasValvePosition = DOAS_CONFIG.GAS_VALVE_MIN_FIRE_VOLTAGE;
                            }
                        }
                    } else {
                        if (stateData.heatStartTime) {
                            delete stateData.heatStartTime;
                        }
                    }
                }
            } else {
                // Normal heating/cooling modes
                const shouldHeat = outdoorTemp < DOAS_CONFIG.HEATING_THRESHOLD && !heatingLockout;
                const shouldCool = outdoorTemp >= DOAS_CONFIG.COOLING_THRESHOLD && !coolingLockout;

                if (shouldHeat) {
                    controlResult.controlMode = 'heating';

                    // Control heating based on SPACE TEMPERATURE
                    const tempError = targetSetpoint - spaceTemp;
                    if (tempError > 0) {
                        controlResult.heatEnable = true;

                        // Track when heat was first enabled for min fire delay
                        const heatCurrentlyOn = this.lastOutputs?.heatEnable || false;
                        if (!heatCurrentlyOn) {
                            // Heat is being turned on - start min fire timer
                            stateData.heatStartTime = now;
                            console.log(`[Element DOAS] Heat starting - running at min fire (${DOAS_CONFIG.GAS_VALVE_MIN_FIRE_VOLTAGE}V) for 3 minutes`);
                        }

                        const heatOnElapsed = stateData.heatStartTime ? (now - stateData.heatStartTime) : 0;

                        if (heatOnElapsed < DOAS_CONFIG.GAS_VALVE_MIN_FIRE_TIME) {
                            // Still in 3-minute min fire period
                            controlResult.gasValvePosition = DOAS_CONFIG.GAS_VALVE_MIN_FIRE_VOLTAGE;
                        } else {
                            // After 3 minutes, modulate based on temperature error
                            const voltageRange = DOAS_CONFIG.GAS_VALVE_MAX_VOLTAGE - DOAS_CONFIG.GAS_VALVE_MIN_FIRE_VOLTAGE;
                            const calculatedVoltage = DOAS_CONFIG.GAS_VALVE_MIN_FIRE_VOLTAGE + (tempError * (voltageRange / 10));
                            controlResult.gasValvePosition = Math.min(DOAS_CONFIG.GAS_VALVE_MAX_VOLTAGE,
                                Math.max(DOAS_CONFIG.GAS_VALVE_MIN_FIRE_VOLTAGE, calculatedVoltage));
                        }
                    } else {
                        controlResult.heatEnable = false;
                        controlResult.gasValvePosition = 0;
                        if (stateData.heatStartTime) {
                            delete stateData.heatStartTime;
                        }
                    }

                } else if (shouldCool) {
                    controlResult.controlMode = 'cooling';

                    // Control cooling based on SPACE TEMPERATURE with minimum run/off times
                    const tempError = spaceTemp - targetSetpoint;
                    const now = Date.now();

                    // Track stage on/off times
                    const stage1CurrentlyOn = this.lastOutputs?.chillerStage1Enable || false;
                    const stage2CurrentlyOn = this.lastOutputs?.chillerStage2Enable || false;

                    // Initialize timers if not present
                    if (!stateData.stage1OnTime && stage1CurrentlyOn) {
                        stateData.stage1OnTime = now;
                    }
                    if (!stateData.stage1OffTime && !stage1CurrentlyOn) {
                        stateData.stage1OffTime = now;
                    }
                    if (!stateData.stage2OnTime && stage2CurrentlyOn) {
                        stateData.stage2OnTime = now;
                    }
                    if (!stateData.stage2OffTime && !stage2CurrentlyOn) {
                        stateData.stage2OffTime = now;
                    }

                    // Calculate elapsed times
                    const stage1OnElapsed = stage1CurrentlyOn ? (now - stateData.stage1OnTime) : 0;
                    const stage1OffElapsed = !stage1CurrentlyOn ? (now - stateData.stage1OffTime) : 0;
                    const stage2OnElapsed = stage2CurrentlyOn ? (now - stateData.stage2OnTime) : 0;
                    const stage2OffElapsed = !stage2CurrentlyOn ? (now - stateData.stage2OffTime) : 0;

                    // Determine desired stage states based on temperature
                    let stage1Desired = false;
                    let stage2Desired = false;

                    if (tempError >= DOAS_CONFIG.DX_STAGE2_THRESHOLD) {
                        stage1Desired = true;
                        stage2Desired = true;
                    } else if (tempError >= DOAS_CONFIG.DX_STAGE1_THRESHOLD) {
                        stage1Desired = true;
                        stage2Desired = false;
                    }

                    // Apply minimum run/off times for Stage 1
                    if (stage1CurrentlyOn) {
                        // Stage 1 is ON - enforce minimum run time
                        if (stage1OnElapsed < DOAS_CONFIG.STAGE_MIN_RUN_TIME) {
                            controlResult.chillerStage1Enable = true;
                        } else {
                            controlResult.chillerStage1Enable = stage1Desired;
                            if (!stage1Desired) {
                                stateData.stage1OffTime = now;
                                delete stateData.stage1OnTime;
                            }
                        }
                    } else {
                        // Stage 1 is OFF - enforce minimum off time
                        if (stage1OffElapsed < DOAS_CONFIG.STAGE_MIN_OFF_TIME) {
                            controlResult.chillerStage1Enable = false;
                        } else {
                            controlResult.chillerStage1Enable = stage1Desired;
                            if (stage1Desired) {
                                stateData.stage1OnTime = now;
                                delete stateData.stage1OffTime;
                            }
                        }
                    }

                    // Apply minimum run/off times for Stage 2
                    if (stage2CurrentlyOn) {
                        // Stage 2 is ON - enforce minimum run time
                        if (stage2OnElapsed < DOAS_CONFIG.STAGE_MIN_RUN_TIME) {
                            controlResult.chillerStage2Enable = true;
                        } else {
                            controlResult.chillerStage2Enable = stage2Desired;
                            if (!stage2Desired) {
                                stateData.stage2OffTime = now;
                                delete stateData.stage2OnTime;
                            }
                        }
                    } else {
                        // Stage 2 is OFF - enforce minimum off time
                        if (stage2OffElapsed < DOAS_CONFIG.STAGE_MIN_OFF_TIME) {
                            controlResult.chillerStage2Enable = false;
                        } else {
                            controlResult.chillerStage2Enable = stage2Desired;
                            if (stage2Desired) {
                                stateData.stage2OnTime = now;
                                delete stateData.stage2OffTime;
                            }
                        }
                    }
                } else {
                    controlResult.controlMode = 'neutral';
                }
            }
        } else {
            controlResult.controlMode = 'unoccupied';
            controlResult.systemEnabled = false;
            stateData.dehumidificationMode = false;
        }

        // State is persisted through stateStorage parameter by logic executor

        // Manual overrides from UI
        if (uiCommands.oaDamperFanEnable !== undefined) {
            controlResult.oaDamperFanEnable = uiCommands.oaDamperFanEnable;
        }
        if (uiCommands.heatEnable !== undefined) {
            controlResult.heatEnable = uiCommands.heatEnable;
        }
        if (uiCommands.gasValvePosition !== undefined) {
            controlResult.gasValvePosition = parseFloat(uiCommands.gasValvePosition);
        }
        if (uiCommands.chillerStage1Enable !== undefined) {
            controlResult.chillerStage1Enable = uiCommands.chillerStage1Enable;
        }
        if (uiCommands.chillerStage2Enable !== undefined) {
            controlResult.chillerStage2Enable = uiCommands.chillerStage2Enable;
        }

        console.log(`[Element DOAS] Control processed: Mode=${controlResult.controlMode}, Fan=${controlResult.oaDamperFanEnable}, Heat=${controlResult.heatEnable}, Gas=${controlResult.gasValvePosition.toFixed(2)}V, Cool1=${controlResult.chillerStage1Enable}, Cool2=${controlResult.chillerStage2Enable}, Supply=${supplyTemp.toFixed(1)}°F, OAT=${outdoorTemp.toFixed(1)}°F, Occupied=${isOccupied}`);

        return controlResult;

    } catch (error) {
        console.error(`[Element DOAS] Error in processDoasControl: ${error.message}`);
        console.error(`[Element DOAS] Error stack: ${error.stack}`);

        // Return safe default state on error
        return {
            equipmentIds: EQUIPMENT_IDS,
            oaDamperFanEnable: false,
            heatEnable: false,
            chillerStage1Enable: false,
            chillerStage2Enable: false,
            supplyFanSpeed: 0,
            gasValvePosition: 0,
            systemEnabled: false,
            emergencyShutdown: true,
            shutdownReason: 'Control system error',
            controlMode: 'error',
            supplyTemp: 0,
            spaceTemp: 0,
            outdoorTemp: 0,
            targetSetpoint: DOAS_CONFIG.DEFAULT_SETPOINT,
            isOccupied: false,
            alarmStatus: 'error',
            faultConditions: ['CONTROL_SYSTEM_ERROR'],
            lastUpdate: new Date().toISOString(),
            controlTimestamp: Date.now(),
            errorMessage: error.message
        };
    }
}

module.exports = {
    processDoasControl,
    doasControl: processDoasControl,
    EQUIPMENT_IDS,
    DOAS_CONFIG
};

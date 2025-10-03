const http = require('http');
const databaseManager = require('./databaseManager');
const vibrationMonitor = require('./vibrationMonitor');

// Configuration
const BMS_CONFIG = {
  locationName: "ElementLabs",
  systemName: "DOAS-1",
  locationId: "8",
  equipmentId: "WBAuutoHnGUtAEc4w6SC",
  equipmentType: "DOAS",
  zone: "Wet_Chem_Lab",
  reportInterval: 45000, // 45 seconds
  influxUrl: "143.198.162.31",
  influxPort: 8181,
  influxPath: "/api/v3/write_lp",
  database: "Locations",
  precision: "nanosecond"
};

class BMSReporter {
  constructor() {
    this.isRunning = false;
    this.reportInterval = null;
  }

  // Get current sensor data from API (same as NodeRedReadings)
  async getSensorData() {
    return new Promise(async (resolve, reject) => {
      http.get('http://localhost:8000/api/boards/current-readings', (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', async () => {
          try {
            const boardData = JSON.parse(data);
            if (!boardData.inputs) {
              console.error('[BMSReporter] No input data available');
              resolve(null);
              return;
            }

      // Parse DOAS data from board readings
      const inputs = boardData.inputs;
      const outputs = boardData.outputs || {};

      // Get setpoint from database or API
      let setpoint = 72; // default
      try {
        const setpointResponse = await new Promise((resolve) => {
          http.get('http://localhost:8000/api/setpoint', (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              try {
                const spData = JSON.parse(data);
                resolve(spData.setpoint || 72);
              } catch (err) {
                resolve(72);
              }
            });
          }).on('error', () => resolve(72));
        });
        setpoint = setpointResponse;
      } catch (err) {
        console.log('[BMSReporter] Could not get setpoint, using default 72');
      }

      // Find space and supply temps from inputs
      let spaceTemp = 0;
      let supplyTemp = 0;

      Object.entries(inputs).forEach(([key, value]) => {
        const keyLower = key.toLowerCase();
        if (keyLower.includes('space') && keyLower.includes('temp')) {
          spaceTemp = parseFloat(value) || 0;
        } else if (keyLower.includes('supply') && keyLower.includes('temp')) {
          supplyTemp = parseFloat(value) || 0;
        }
      });

      const sensorData = {
        // System status
        fanStatus: (outputs.triacs && outputs.triacs.triac1) ? "on" : "off",
        temperatureSetpoint: setpoint,
        stage1Status: (outputs.triacs && outputs.triacs.triac3) || false,
        stage2Status: (outputs.triacs && outputs.triacs.triac4) || false,
        isFiring: (outputs.triacs && outputs.triacs.triac2) || false,

        // Temperature readings
        spaceTemp: spaceTemp,
        supplyTemp: supplyTemp,
        outdoorAirTemp: 0,                    // Will be populated from weather API
        intakeAir: 0,                         // Intake = outdoor air (populated from weather)

        // VFD speed
        vfdSpeed: (outputs.analog && outputs.analog.ao1) || 0,

        // Gas valve position (0-100%)
        gasValvePosition: (outputs.analog && outputs.analog.ao2) || 0,

        // Humidity (will be populated from weather API)
        labRH: 0,
        outdoorHumidity: 0
      };

      // Get outdoor temperature and humidity from weather API
      try {
        const weatherResponse = await new Promise((resolve) => {
          http.get('http://localhost:8000/api/weather', (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              try {
                const weather = JSON.parse(data);
                resolve(weather);
              } catch (err) {
                resolve(null);
              }
            });
          }).on('error', () => resolve(null));
        });

        if (weatherResponse) {
          sensorData.outdoorAirTemp = weatherResponse.temperature || 0;
          sensorData.intakeAir = weatherResponse.temperature || 0;  // Intake = outdoor air for DOAS
          sensorData.outdoorHumidity = weatherResponse.humidity || 0;
        }
      } catch (err) {
        console.log('[BMSReporter] Could not get weather data:', err.message);
      }

            resolve(sensorData);
          } catch (error) {
            console.error('[BMSReporter] Error parsing board data:', error);
            resolve(null);
          }
        });
      }).on('error', (error) => {
        console.error('[BMSReporter] Error fetching board data:', error);
        resolve(null);
      });
    });
  }

  // Generate InfluxDB line protocol for DOAS
  generateLineProtocol(data) {
    // Build line protocol string matching the Node-RED format exactly
    const lineProtocol = `metrics,` +
      `location=${BMS_CONFIG.locationName},` +
      `system=${BMS_CONFIG.systemName},` +
      `equipment_type=${BMS_CONFIG.equipmentType},` +
      `location_id=${BMS_CONFIG.locationId},` +
      `equipmentId=${BMS_CONFIG.equipmentId},` +
      `zone=${BMS_CONFIG.zone} ` +                          // SPACE separates tags from fields
      `FanStatus="${data.fanStatus}",` +                    // String field - quoted
      `TemperatureSetpoint=${data.temperatureSetpoint},` +  // Numeric field - not quoted
      `SupplyTemp=${data.supplyTemp.toFixed(1)},` +         // Numeric field - not quoted
      `intakeAir=${data.intakeAir.toFixed(1)},` +           // Numeric field - not quoted
      `SpaceTemp=${data.spaceTemp.toFixed(1)},` +           // Numeric field - not quoted
      `outdoorAirTemp=${data.outdoorAirTemp.toFixed(1)},` + // Numeric field - not quoted
      `labRH=${data.labRH.toFixed(1)},` +                   // Numeric field - not quoted
      `outdoorHumidity=${data.outdoorHumidity.toFixed(1)},` + // Numeric field - not quoted
      `vfdSpeed=${data.vfdSpeed.toFixed(1)},` +             // Numeric field - not quoted
      `Stage1=${data.stage1Status ? 't' : 'f'},` +          // Boolean field - not quoted
      `Stage2=${data.stage2Status ? 't' : 'f'},` +          // Boolean field - not quoted
      `isFiring=${data.isFiring ? 't' : 'f'},` +            // Boolean field - not quoted
      `CustomLogicEnabled=t,` +                              // Boolean field - not quoted
      `TemperatureSource="OAR",` +                           // String field - quoted
      `source="NeuralBMS"`;                                  // String field - quoted (no trailing comma)

    return lineProtocol;
  }

  // Send data to InfluxDB via HTTP
  sendToInfluxDB(lineProtocol) {
    return new Promise((resolve, reject) => {
      const postData = lineProtocol;

      const options = {
        hostname: BMS_CONFIG.influxUrl,
        port: BMS_CONFIG.influxPort,
        path: `${BMS_CONFIG.influxPath}?db=${BMS_CONFIG.database}&precision=${BMS_CONFIG.precision}`,
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = http.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode === 204 || res.statusCode === 200) {
            console.log(`[BMSReporter] DOAS-1 data sent successfully`);
            resolve({ success: true });
          } else {
            console.error(`[BMSReporter] Failed to send DOAS-1 data: ${res.statusCode}`);
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', (error) => {
        console.error(`[BMSReporter] Error sending DOAS-1 data:`, error.message);
        reject(error);
      });

      // Write data to request body
      req.write(postData);
      req.end();
    });
  }

  // Send DOAS data
  async sendDoasData() {
    try {
      // Get current sensor data
      const sensorData = await this.getSensorData();

      if (!sensorData) {
        console.error('[BMSReporter] No sensor data available, skipping report');
        return;
      }

      console.log('[BMSReporter] Sending DOAS data to BMS server...');

      // Generate line protocol
      const lineProtocol = this.generateLineProtocol(sensorData);

      // Debug log first 200 chars
      console.log(`[BMSReporter] ElementLabs DOAS: ${lineProtocol.substring(0, 200)}...`);

      await this.sendToInfluxDB(lineProtocol);

      console.log('[BMSReporter] BMS report cycle completed');
    } catch (error) {
      console.error('[BMSReporter] Error in sendDoasData:', error);
    }
  }

  // Start the reporting service
  start() {
    if (this.isRunning) {
      console.log('[BMSReporter] Already running');
      return;
    }

    console.log('[BMSReporter] Starting BMS reporting service for DOAS-1...');
    this.isRunning = true;

    // Send initial report
    this.sendDoasData();

    // Set up interval for periodic reporting
    this.reportInterval = setInterval(() => {
      this.sendDoasData();
    }, BMS_CONFIG.reportInterval);

    console.log(`[BMSReporter] Reporting every ${BMS_CONFIG.reportInterval / 1000} seconds to ${BMS_CONFIG.influxUrl}`);
  }

  // Stop the reporting service
  stop() {
    if (!this.isRunning) {
      console.log('[BMSReporter] Not running');
      return;
    }

    if (this.reportInterval) {
      clearInterval(this.reportInterval);
      this.reportInterval = null;
    }

    this.isRunning = false;
    console.log('[BMSReporter] Stopped');
  }

  // Get service status
  getStatus() {
    return {
      running: this.isRunning,
      config: BMS_CONFIG,
      lastReport: this.lastReport || null
    };
  }
}

// Create singleton instance
const bmsReporter = new BMSReporter();

// Start the reporter automatically
bmsReporter.start();

module.exports = bmsReporter;
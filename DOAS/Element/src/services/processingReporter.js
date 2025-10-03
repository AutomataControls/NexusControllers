const http = require('http');
const databaseManager = require('./databaseManager');

// Configuration
const PROCESSING_CONFIG = {
  locationName: "ElementLabs",
  locationId: "8",
  equipmentId: "WBAuutoHnGUtAEc4w6SC",
  equipmentType: "DOAS",
  zone: "Wet_Chem_Lab",
  reportInterval: 300000, // 5 minutes (300 seconds)
  influxUrl: "143.198.162.31",
  influxPort: 8181,
  influxQueryPath: "/api/v3/query_sql"
};

class ProcessingReporter {
  constructor() {
    this.isRunning = false;
    this.reportInterval = null;
  }

  // Query BMS for setpoint command
  async queryBmsSetpoint() {
    return new Promise((resolve, reject) => {
      const query = {
        q: `SELECT "tempSetpoint", "tempSupplySetpoint", "tempSpaceSetpoint", "controlType", time FROM "UIControlCommands" WHERE "equipmentId" = '${PROCESSING_CONFIG.equipmentId}' AND "locationId" = '${PROCESSING_CONFIG.locationId}' ORDER BY time DESC LIMIT 1`,
        db: "UIControlCommands"
      };

      const postData = JSON.stringify(query);

      const options = {
        hostname: PROCESSING_CONFIG.influxUrl,
        port: PROCESSING_CONFIG.influxPort,
        path: PROCESSING_CONFIG.influxQueryPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 5000
      };

      const req = http.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const result = JSON.parse(data);

              // Parse InfluxDB v3 response (returns flat array)
              if (Array.isArray(result) && result.length > 0) {
                const row = result[0];

                if (row.tempSpaceSetpoint !== undefined && row.tempSpaceSetpoint !== null) {
                  const setpoint = parseFloat(row.tempSpaceSetpoint);
                  console.log(`[ProcessingReporter] BMS setpoint retrieved: ${setpoint}°F`);
                  resolve(setpoint);
                  return;
                }
              }

              console.log('[ProcessingReporter] No BMS setpoint command found');
              resolve(null);
            } else {
              console.error(`[ProcessingReporter] BMS query failed: ${res.statusCode}`);
              resolve(null);
            }
          } catch (error) {
            console.error('[ProcessingReporter] Error parsing BMS response:', error);
            resolve(null);
          }
        });
      });

      req.on('error', (error) => {
        console.error('[ProcessingReporter] Error querying BMS:', error.message);
        resolve(null);
      });

      req.on('timeout', () => {
        console.error('[ProcessingReporter] BMS query timeout');
        req.destroy();
        resolve(null);
      });

      req.write(postData);
      req.end();
    });
  }

  // Apply setpoint to local system
  async applySetpoint(setpoint) {
    try {
      // Update in database
      const stmt = databaseManager.metricsDb.prepare(
        'INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)'
      );
      stmt.run('user_setpoint', setpoint.toString(), Date.now());

      console.log(`[ProcessingReporter] Applied BMS setpoint: ${setpoint}°F`);
      return true;
    } catch (error) {
      console.error('[ProcessingReporter] Error applying setpoint:', error);
      return false;
    }
  }

  // Check for BMS setpoint and apply if found
  async checkAndApplyBmsSetpoint() {
    try {
      console.log('[ProcessingReporter] Querying BMS for setpoint command...');

      const bmsSetpoint = await this.queryBmsSetpoint();

      if (bmsSetpoint !== null && !isNaN(bmsSetpoint)) {
        // Valid setpoint from BMS - apply it
        await this.applySetpoint(bmsSetpoint);
        console.log(`[ProcessingReporter] BMS setpoint applied: ${bmsSetpoint}°F`);
      } else {
        // No BMS setpoint - keep using local setpoint
        console.log('[ProcessingReporter] No BMS setpoint found, using local setpoint');
      }

      console.log('[ProcessingReporter] Setpoint check cycle completed');
    } catch (error) {
      console.error('[ProcessingReporter] Error in checkAndApplyBmsSetpoint:', error);
    }
  }

  // Start the reporting service
  start() {
    if (this.isRunning) {
      console.log('[ProcessingReporter] Already running');
      return;
    }

    console.log('[ProcessingReporter] Starting BMS setpoint sync service...');
    this.isRunning = true;

    // Check immediately on start
    this.checkAndApplyBmsSetpoint();

    // Set up interval for periodic checking (every 5 minutes)
    this.reportInterval = setInterval(() => {
      this.checkAndApplyBmsSetpoint();
    }, PROCESSING_CONFIG.reportInterval);

    console.log(`[ProcessingReporter] Checking BMS setpoint every ${PROCESSING_CONFIG.reportInterval / 1000} seconds from ${PROCESSING_CONFIG.influxUrl}:${PROCESSING_CONFIG.influxPort}`);
  }

  // Stop the reporting service
  stop() {
    if (!this.isRunning) {
      console.log('[ProcessingReporter] Not running');
      return;
    }

    if (this.reportInterval) {
      clearInterval(this.reportInterval);
      this.reportInterval = null;
    }

    this.isRunning = false;
    console.log('[ProcessingReporter] Stopped');
  }

  // Get service status
  getStatus() {
    return {
      running: this.isRunning,
      config: PROCESSING_CONFIG
    };
  }
}

// Create singleton instance
const processingReporter = new ProcessingReporter();

// Start the reporter automatically
processingReporter.start();

module.exports = processingReporter;
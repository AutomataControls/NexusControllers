import React, { useState, useEffect } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine
} from 'recharts';

interface ChartDataPoint {
  time: string;
  setpoint?: number;
  supply?: number;
  return?: number;
  space?: number;
  oat?: number;
  hpSupply?: number;  // HP Loop Supply temperature
  amps?: number;
  // Additional current sensors
  amps1?: number;
  amps2?: number;
  amps3?: number;
  amps4?: number;
  amps5?: number;
  amps6?: number;
  triac1?: number;
  triac2?: number;
  triac3?: number;
  triac4?: number;
  [key: string]: any; // Allow dynamic amp keys
}

type GraphType = 'temperature' | 'amps' | 'triacs';

const TrendGraph: React.FC = () => {
  const [graphType, setGraphType] = useState<GraphType>('temperature');
  const [data, setData] = useState<ChartDataPoint[]>([]);
  const [timeRange, setTimeRange] = useState<number>(8); // hours
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [currentSensorNames, setCurrentSensorNames] = useState<Map<string, string>>(new Map());
  const [thresholds] = useState({
    tempHigh: 85,
    tempLow: 65,
    ampsHigh: 40,
    ampsLow: 5
  });

  // Fetch real sensor data from boards
  const fetchSensorData = async () => {
    try {
      // Fetch real data from board readings API
      const response = await fetch('/api/boards/current-readings');
      if (response.ok) {
        const boardData = await response.json();
        
        const now = new Date();
        // For longer time ranges, include date info
        const timeStr = timeRange > 8
          ? now.toLocaleString('en-US', {
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'America/New_York'
            })
          : now.toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'America/New_York'
            });
        
        const newPoint: ChartDataPoint = {
          time: timeStr
        };
        
        // Map board data to chart data based on configuration
        if (boardData.inputs) {
          // Track current sensor indices
          let currentIndex = 1;
          const sensorNameMap = new Map<string, string>();

          // Map all available inputs
          Object.entries(boardData.inputs).forEach(([key, value]) => {
            const keyLower = key.toLowerCase();

            // Map to chart data points based on input names
            if ((keyLower.includes('supply') && keyLower.includes('air')) || (keyLower.includes('tower') && keyLower.includes('supply'))) {
              newPoint.supply = parseFloat(value as string);
            } else if (keyLower.includes('tower') && keyLower.includes('return')) {
              newPoint.return = parseFloat(value as string);
            } else if (keyLower.includes('hp') && keyLower.includes('supply')) {
              // Store HP loop supply separately for display
              newPoint.hpSupply = parseFloat(value as string);
              // Also use as backup for supply if tower supply not available
              if (!newPoint.supply) {
                newPoint.supply = parseFloat(value as string);
              }
            } else if (keyLower.includes('hp') && keyLower.includes('return')) {
              // Use HP loop return as secondary option for return if tower return not available
              if (!newPoint.return) {
                newPoint.return = parseFloat(value as string);
              }
            } else if (keyLower.includes('outdoor_air') || keyLower.includes('oat')) {
              newPoint.oat = parseFloat(value as string);
            } else if (keyLower === 'space' || keyLower.includes('space_temp')) {
              newPoint.space = parseFloat(value as string);
            } else if (keyLower.includes('current') || keyLower.includes('amps') || keyLower.includes('vfd')) {
              // Map all current sensors dynamically
              const ampKey = `amps${currentIndex}`;
              newPoint[ampKey] = parseFloat(value as string);
              sensorNameMap.set(ampKey, key); // Store original name for legend
              currentIndex++;
            } else if (keyLower === 'setpoint') {
              newPoint.setpoint = parseFloat(value as string);
            }
          });

          // Update sensor names if we found any
          if (sensorNameMap.size > 0) {
            setCurrentSensorNames(sensorNameMap);
          }
        }
        
        // Triac states from outputs
        if (boardData.outputs && boardData.outputs.triacs) {
          newPoint.triac1 = boardData.outputs.triacs.triac1 ? 1 : 0;
          newPoint.triac2 = boardData.outputs.triacs.triac2 ? 1 : 0;
          newPoint.triac3 = boardData.outputs.triacs.triac3 ? 1 : 0;
          newPoint.triac4 = boardData.outputs.triacs.triac4 ? 1 : 0;
        }

        // Only add data if we have some readings
        if (Object.keys(newPoint).length > 1) {
          setIsConnected(true);
          setData(prevData => {
            const updated = [...prevData, newPoint];
            const intervalMinutes = timeRange <= 1 ? 1 : timeRange <= 4 ? 5 : 15;
            const maxPoints = Math.floor((timeRange * 60) / intervalMinutes);
            if (updated.length > maxPoints) {
              return updated.slice(-maxPoints);
            }
            return updated;
          });
        }
      }
    } catch (err) {
      console.error('Failed to fetch sensor data:', err);
      setIsConnected(false);
    }
  };

  // Load historical data when component mounts or time range changes
  useEffect(() => {
    const loadHistoricalData = async () => {
      try {
        // Fetch historical data from database
        const response = await fetch(`/api/boards/historical-data?hours=${timeRange}`);
        if (response.ok) {
          const historicalData = await response.json();
          if (historicalData && historicalData.length > 0) {
            setData(historicalData);
            setIsConnected(true);
          }
        }
      } catch (err) {
        console.error('Failed to load historical data:', err);
      }
    };
    
    loadHistoricalData();
  }, [timeRange]);

  // Poll for new sensor data
  useEffect(() => {
    fetchSensorData();
    const interval = setInterval(fetchSensorData, 30000);
    return () => clearInterval(interval);
  }, [timeRange]);

  const graphTitles = {
    temperature: 'Temperature Trends',
    amps: 'Current Trends',
    triacs: 'VFD Enable Status'
  };

  const handleNextGraph = () => {
    const types: GraphType[] = ['temperature', 'amps', 'triacs'];
    const currentIndex = types.indexOf(graphType);
    setGraphType(types[(currentIndex + 1) % types.length]);
  };

  const handlePrevGraph = () => {
    const types: GraphType[] = ['temperature', 'amps', 'triacs'];
    const currentIndex = types.indexOf(graphType);
    setGraphType(types[(currentIndex - 1 + types.length) % types.length]);
  };

  const renderChart = () => {
    // Show "Connect Sensors" message if no data
    if (!isConnected || data.length === 0) {
      return (
        <div style={{ 
          height: 250, 
          display: 'flex', 
          flexDirection: 'column',
          alignItems: 'center', 
          justifyContent: 'center',
          background: '#f9fafb',
          borderRadius: '8px',
          border: '2px dashed #d1d5db'
        }}>
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
          <h3 style={{ 
            marginTop: '1rem', 
            marginBottom: '0.5rem',
            color: '#6b7280',
            fontSize: '1.125rem',
            fontWeight: 600
          }}>
            Connect Sensors
          </h3>
          <p style={{ 
            color: '#9ca3af', 
            fontSize: '0.875rem',
            textAlign: 'center',
            maxWidth: '250px'
          }}>
            No sensor data available. Please ensure boards are connected and configured.
          </p>
        </div>
      );
    }

    if (graphType === 'temperature') {
      return (
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={data} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis
              dataKey="time"
              stroke="#9ca3af"
              fontSize={12}
              interval={(() => {
                // Calculate proper interval based on time range and data points
                const totalPoints = data.length;

                if (timeRange <= 1) {
                  // 1 hour: show every 10 minutes (20 points)
                  return Math.max(1, Math.floor(totalPoints / 6));
                } else if (timeRange <= 4) {
                  // 4 hours: show every 30 minutes
                  return Math.max(1, Math.floor(totalPoints / 8));
                } else if (timeRange <= 8) {
                  // 8 hours: show every hour
                  return Math.max(1, Math.floor(totalPoints / 8));
                } else {
                  // 24 hours: show every 2-3 hours
                  return Math.max(1, Math.floor(totalPoints / 10));
                }
              })()}
              angle={-45}
              textAnchor="end"
              height={60}
            />
            <YAxis
              stroke="#9ca3af"
              fontSize={12}
              domain={[50, 95]}
              tickFormatter={(value) => `${value.toFixed(0)}°F`}
            />
            <Tooltip 
              contentStyle={{ 
                backgroundColor: 'rgba(255, 255, 255, 0.95)',
                border: '1px solid #e5e7eb',
                borderRadius: '0.375rem'
              }}
              formatter={(value: number) => [`${value?.toFixed(1)}°F`, '']}
            />
            <Legend
              iconType="line"
              formatter={(value, entry) => (
                <span style={{
                  color: entry.color && entry.color.includes('rgba')
                    ? entry.color.replace(/[\d.]+\)/, '1)') // Make legend text fully opaque
                    : entry.color,
                  fontWeight: 600
                }}>
                  {value}
                </span>
              )}
            />
            
            {/* Threshold lines */}
            <ReferenceLine
              y={thresholds.tempHigh}
              stroke="rgba(239, 68, 68, 0.3)"
              strokeDasharray="5 5"
            />
            <ReferenceLine
              y={thresholds.tempLow}
              stroke="rgba(239, 68, 68, 0.3)"
              strokeDasharray="5 5"
            />
            <ReferenceLine 
              y={70} 
              stroke="rgba(34, 197, 94, 0.3)" 
              strokeDasharray="3 3" 
              label="Setpoint"
            />
            
            {/* Data lines */}
            {data.some(d => d.supply !== undefined) && (
              <Line
                type="monotone"
                dataKey="supply"
                stroke="#fed7aa"
                strokeWidth={2.5}
                dot={false}
                name="Supply Air"
                legendType="line"
              />
            )}
            {data.some(d => d.return !== undefined) && (
              <Line
                type="monotone"
                dataKey="return"
                stroke="rgba(245, 158, 11, 0.3)"
                strokeWidth={2.5}
                dot={false}
                name="Tower Return"
                legendType="line"
              />
            )}
            {data.some(d => d.oat !== undefined) && (
              <Line
                type="monotone"
                dataKey="oat"
                stroke="#8b5cf6"
                strokeWidth={2}
                dot={false}
                name="Outside Air"
              />
            )}
            {data.some(d => d.space !== undefined) && (
              <Line
                type="monotone"
                dataKey="space"
                stroke="#10b981"
                strokeWidth={2}
                dot={false}
                name="Space"
              />
            )}
            {data.some(d => d.hpSupply !== undefined) && (
              <Line
                type="monotone"
                dataKey="hpSupply"
                stroke="rgba(239, 68, 68, 0.5)"
                strokeWidth={2}
                dot={false}
                name="HP Loop Supply"
                legendType="line"
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      );
    } else if (graphType === 'amps') {
      // Define colors for different current sensors
      const ampColors = ['#f59e0b', '#0ea5e9', '#10b981', '#8b5cf6', '#ec4899', '#06b6d4'];

      // Find all amp keys in the data
      const ampKeys = new Set<string>();
      data.forEach(point => {
        Object.keys(point).forEach(key => {
          if (key.startsWith('amps') && key !== 'amps') {
            ampKeys.add(key);
          }
        });
      });

      return (
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={data} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis
              dataKey="time"
              stroke="#9ca3af"
              fontSize={12}
              interval={timeRange <= 1 ? 'preserveStartEnd' : timeRange <= 4 ? Math.floor(data.length / 8) : Math.floor(data.length / 6)}
              angle={-45}
              textAnchor="end"
              height={60}
            />
            <YAxis
              stroke="#9ca3af"
              fontSize={12}
              domain={[0, 50]}
              tickFormatter={(value) => `${value.toFixed(0)}A`}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'rgba(255, 255, 255, 0.95)',
                border: '1px solid #e5e7eb',
                borderRadius: '0.375rem'
              }}
              formatter={(value: number) => [`${value?.toFixed(1)}A`, '']}
            />
            <Legend
              iconType="line"
              formatter={(value, entry) => (
                <span style={{
                  color: entry.color && entry.color.includes('rgba')
                    ? entry.color.replace(/[\d.]+\)/, '1)') // Make legend text fully opaque
                    : entry.color,
                  fontWeight: 600
                }}>
                  {value}
                </span>
              )}
            />

            {/* Threshold lines */}
            <ReferenceLine
              y={thresholds.ampsHigh}
              stroke="rgba(239, 68, 68, 0.3)"
              strokeDasharray="5 5"
              label="High Limit"
            />
            <ReferenceLine
              y={thresholds.ampsLow}
              stroke="rgba(34, 197, 94, 0.3)"
              strokeDasharray="5 5"
              label="Running"
            />

            {/* Render a line for each current sensor */}
            {Array.from(ampKeys).sort().map((key, index) => {
              const sensorName = currentSensorNames.get(key) || key;
              const displayName = sensorName
                .replace(/_/g, ' ')
                .replace(/tower/gi, 'Tower')
                .replace(/pump/gi, 'Pump')
                .replace(/vfd/gi, 'VFD')
                .replace(/current/gi, '')
                .replace(/amps/gi, '')
                .trim();

              return (
                <Line
                  key={key}
                  type="monotone"
                  dataKey={key}
                  stroke={ampColors[index % ampColors.length]}
                  strokeWidth={2.5}
                  dot={false}
                  name={displayName || `Current ${index + 1}`}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      );
    } else {
      // Triacs graph
      return (
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={data} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis
              dataKey="time"
              stroke="#9ca3af"
              fontSize={12}
              interval={(() => {
                // Calculate proper interval based on time range and data points
                const totalPoints = data.length;

                if (timeRange <= 1) {
                  // 1 hour: show every 10 minutes (20 points)
                  return Math.max(1, Math.floor(totalPoints / 6));
                } else if (timeRange <= 4) {
                  // 4 hours: show every 30 minutes
                  return Math.max(1, Math.floor(totalPoints / 8));
                } else if (timeRange <= 8) {
                  // 8 hours: show every hour
                  return Math.max(1, Math.floor(totalPoints / 8));
                } else {
                  // 24 hours: show every 2-3 hours
                  return Math.max(1, Math.floor(totalPoints / 10));
                }
              })()}
              angle={-45}
              textAnchor="end"
              height={60}
            />
            <YAxis 
              stroke="#9ca3af"
              fontSize={12}
              domain={[0, 1]}
              ticks={[0, 1]}
              tickFormatter={(value) => value > 0.5 ? 'ON' : 'OFF'}
            />
            <Tooltip 
              contentStyle={{ 
                backgroundColor: 'rgba(255, 255, 255, 0.95)',
                border: '1px solid #e5e7eb',
                borderRadius: '0.375rem'
              }}
              formatter={(value: number) => value > 0.5 ? 'ON' : 'OFF'}
            />
            <Legend
              iconType="line"
              formatter={(value, entry) => (
                <span style={{
                  color: entry.color && entry.color.includes('rgba')
                    ? entry.color.replace(/[\d.]+\)/, '1)') // Make legend text fully opaque
                    : entry.color,
                  fontWeight: 600
                }}>
                  {value}
                </span>
              )}
            />
            
            <Line 
              type="stepAfter" 
              dataKey="triac1" 
              stroke="#0ea5e9" 
              strokeWidth={2.5}
              dot={false}
              name="Tower 1 VFD"
            />
            <Line 
              type="stepAfter" 
              dataKey="triac2" 
              stroke="#10b981" 
              strokeWidth={2.5}
              dot={false}
              name="Tower 2 VFD"
            />
            <Line 
              type="stepAfter" 
              dataKey="triac3" 
              stroke="#f59e0b" 
              strokeWidth={2.5}
              dot={false}
              name="Tower 3 VFD"
            />
            <Line 
              type="stepAfter" 
              dataKey="triac4" 
              stroke="#8b5cf6" 
              strokeWidth={2}
              strokeDasharray="5 5"
              dot={false}
              name="Spare"
            />
          </LineChart>
        </ResponsiveContainer>
      );
    }
  };

  return (
    <div className="trend-graph-card">
      <div className="trend-header">
        <button className="trend-nav-btn" onClick={handlePrevGraph}>‹</button>
        <h3 style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <span>
            {graphTitles[graphType]}
          </span>
        </h3>
        <div className="trend-controls">
          <select 
            className="time-range-select" 
            value={timeRange} 
            onChange={(e) => setTimeRange(Number(e.target.value))}
          >
            <option value={1}>1 Hour</option>
            <option value={4}>4 Hours</option>
            <option value={8}>8 Hours</option>
            <option value={24}>24 Hours</option>
          </select>
          <div className="trend-status">
            <span className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`}></span>
            {isConnected ? 'Live' : 'Offline'}
          </div>
        </div>
        <button className="trend-nav-btn" onClick={handleNextGraph}>›</button>
      </div>
      <div style={{ padding: '1rem' }}>
        {renderChart()}
      </div>
    </div>
  );
};

export default TrendGraph;
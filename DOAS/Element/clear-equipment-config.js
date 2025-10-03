#!/usr/bin/env node
// Clear equipment configuration from database

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'metrics.db');
const db = new Database(dbPath);

try {
    console.log('Clearing equipment_config table...');

    // Delete all equipment config entries
    const result = db.prepare('DELETE FROM equipment_config').run();

    console.log(`Deleted ${result.changes} equipment config entries`);

    // Show remaining entries (should be 0)
    const remaining = db.prepare('SELECT COUNT(*) as count FROM equipment_config').get();
    console.log(`Remaining entries: ${remaining.count}`);

    console.log('\nEquipment configuration cleared successfully!');

} catch (error) {
    console.error('Error clearing equipment config:', error.message);
} finally {
    db.close();
}

import { PageSensor } from '../page/sensor';

// Initialize PageSensor at document_start
const navigationId = `page_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
const sensor = new PageSensor(navigationId);
sensor.init();

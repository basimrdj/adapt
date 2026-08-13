import { PageSensor } from '../page/sensor';
import { PageFilteringRuntime } from '../page/filtering/runtime';

// Initialize PageSensor at document_start
const navigationId = `page_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
const pageFiltering = new PageFilteringRuntime();
const sensor = new PageSensor(navigationId);
pageFiltering.init();
sensor.init();

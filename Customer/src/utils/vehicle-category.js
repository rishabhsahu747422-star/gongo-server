'use strict';

/**
 * Resolves vehicle category to either 'CAR' or 'BIKE' from vehicle properties.
 *
 * @param {object} vehicle
 * @returns {'CAR'|'BIKE'}
 */
function resolveVehicleCategory(vehicle) {
  if (!vehicle) return 'BIKE';
  const cat = String(
    vehicle.category_slug ||
    vehicle.category ||
    vehicle.vehicleCategory ||
    vehicle.vehicle_category ||
    vehicle.category_name ||
    ''
  ).toUpperCase();

  const subtype = String(vehicle.vehicle_subtype || vehicle.vehicleSubtype || '').toUpperCase();
  const seats = Number(vehicle.seats || 0);

  if (
    cat.includes('CAR') ||
    cat === 'SEDAN' ||
    cat === 'SUV' ||
    cat === 'HATCHBACK' ||
    subtype.includes('CAR') ||
    subtype === 'SEDAN' ||
    subtype === 'SUV' ||
    subtype === 'HATCHBACK' ||
    seats > 2
  ) {
    return 'CAR';
  }

  return 'BIKE';
}

module.exports = {
  resolveVehicleCategory,
};

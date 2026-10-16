'use strict';

const request = require('supertest');

jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  http: jest.fn(),
}));

const publicVehicleRepository = require('../../src/repositories/public-vehicle.repository');
const { createApp } = require('../../src/app');

const app = createApp();

describe('Integration: Public Vehicle Discovery & Quick Finder', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    publicVehicleRepository.constructor.setMockResolver({
      getCategories: async () => [
        { id: 'cat-1', name: 'Motorcycles', slug: 'motorcycles', description: 'Two wheelers' },
        { id: 'cat-2', name: 'Scooters', slug: 'scooters', description: 'Automatic two wheelers' },
        { id: 'cat-3', name: 'Electric Scooters', slug: 'electric-scooters', description: 'Eco-friendly rides' },
      ],
      getCities: async () => [
        { id: 'city-1', name: 'Bangalore', state: 'Karnataka', country_code: 'IN' },
        { id: 'city-2', name: 'Bhopal', state: 'Madhya Pradesh', country_code: 'IN' },
        { id: 'city-3', name: 'Delhi', state: 'Delhi', country_code: 'IN' },
      ],
      searchVehicles: async ({ city, vehicleType, pickupDate }) => {
        const allVehicles = [
          {
            id: 'v-001',
            name: 'Royal Enfield Classic 350',
            make: 'Royal Enfield',
            model: 'Classic 350',
            categoryName: 'Motorcycles',
            categorySlug: 'motorcycles',
            city: 'Bhopal',
            location: 'MP Nagar, Bhopal',
            images: ['https://example.com/classic350.jpg'],
            pricePerDay: 800,
            hourlyRate: 80,
            securityDeposit: 1500,
            fuelType: 'PETROL',
            transmission: 'MANUAL',
            isAvailable: true,
          },
          {
            id: 'v-002',
            name: 'Honda Activa 6G',
            make: 'Honda',
            model: 'Activa 6G',
            categoryName: 'Scooters',
            categorySlug: 'scooters',
            city: 'Bhopal',
            location: 'Arera Colony, Bhopal',
            images: ['https://example.com/activa.jpg'],
            pricePerDay: 450,
            hourlyRate: 50,
            securityDeposit: 1000,
            fuelType: 'PETROL',
            transmission: 'AUTOMATIC',
            isAvailable: true,
          },
        ];

        let filtered = allVehicles;
        if (city && city.toLowerCase() !== 'all') {
          filtered = filtered.filter((v) => v.city.toLowerCase() === city.toLowerCase());
        }
        if (vehicleType && vehicleType.toLowerCase() !== 'all') {
          filtered = filtered.filter(
            (v) => v.categorySlug.toLowerCase() === vehicleType.toLowerCase() ||
                   v.categoryName.toLowerCase() === vehicleType.toLowerCase()
          );
        }
        return {
          vehicles: filtered,
          total: filtered.length,
          query: { city, vehicleType, pickupDate },
        };
      },
    });
  });

  afterAll(() => {
    publicVehicleRepository.constructor.resetMockResolver();
  });

  it('GET /api/v1/public/categories returns list of active vehicle categories', async () => {
    const res = await request(app).get('/api/v1/public/categories');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.categories).toHaveLength(3);
    expect(res.body.data.categories[0].slug).toBe('motorcycles');
  });

  it('GET /api/v1/public/cities returns list of operational cities', async () => {
    const res = await request(app).get('/api/v1/public/cities');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.cities).toHaveLength(3);
    expect(res.body.data.cities[1].name).toBe('Bhopal');
  });

  it('GET /api/v1/public/vehicles/search finds available vehicles with valid filters', async () => {
    // Tomorrow's date
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    const res = await request(app)
      .get(`/api/v1/public/vehicles/search?city=Bhopal&vehicleType=motorcycles&pickupDate=${tomorrow}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.vehicles).toHaveLength(1);
    expect(res.body.data.vehicles[0].name).toBe('Royal Enfield Classic 350');
    expect(res.body.data.total).toBe(1);
  });

  it('GET /api/v1/public/vehicles/search rejects past pickup dates with 400', async () => {
    const res = await request(app)
      .get('/api/v1/public/vehicles/search?city=Bhopal&vehicleType=motorcycles&pickupDate=2020-01-01');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/cannot be in the past/i);
  });

  it('GET /api/v1/public/vehicles/search works via alias route /api/v1/vehicles/search', async () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    const res = await request(app)
      .get(`/api/v1/vehicles/search?city=Bhopal&pickupDate=${tomorrow}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.vehicles).toHaveLength(2);
  });
});

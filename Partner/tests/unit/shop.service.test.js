'use strict';

const shopService = require('../../src/services/shop.service');
const { NotFoundError } = require('../../src/errors');

describe('Unit: ShopService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getShop', () => {
    it('returns formatted shop data for partner', async () => {
      jest.spyOn(shopService.shopRepository, 'findByPartnerId').mockResolvedValue({
        id: 'shop-101',
        partner_id: 'partner-101',
        shop_name: 'City Wheels',
        shop_address: '44 Main Road',
        city: 'Indore',
        latitude: '22.7196000',
        longitude: '75.8577000',
        operating_info: '09:00 AM - 08:00 PM',
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const shop = await shopService.getShop('partner-101');
      expect(shop.id).toBe('shop-101');
      expect(shop.shopName).toBe('City Wheels');
      expect(shop.city).toBe('Indore');
      expect(shop.latitude).toBe(22.7196);
      expect(shop.longitude).toBe(75.8577);
      expect(typeof shop.latitude).toBe('number');
    });

    it('throws NotFoundError when shop does not exist', async () => {
      jest.spyOn(shopService.shopRepository, 'findByPartnerId').mockResolvedValue(null);

      await expect(shopService.getShop('partner-no-shop')).rejects.toThrow(NotFoundError);
    });
  });

  describe('updateShop', () => {
    it('updates shop details and returns formatted shop', async () => {
      const existing = {
        id: 'shop-101',
        partner_id: 'partner-101',
        shop_name: 'City Wheels',
        city: 'Indore',
      };
      const updatedRow = {
        ...existing,
        shop_name: 'City Wheels Premium',
        shop_address: 'New Address',
        latitude: 22.72,
        longitude: 75.86,
      };

      jest.spyOn(shopService.shopRepository, 'findByPartnerId').mockResolvedValue(existing);
      jest.spyOn(shopService.shopRepository, 'updateShop').mockResolvedValue(updatedRow);

      const result = await shopService.updateShop('partner-101', {
        shopName: 'City Wheels Premium',
        shopAddress: 'New Address',
        latitude: 22.72,
        longitude: 75.86,
      });

      expect(result.shopName).toBe('City Wheels Premium');
      expect(result.latitude).toBe(22.72);
      expect(result.longitude).toBe(75.86);
    });

    it('throws NotFoundError when updating non-existent shop', async () => {
      jest.spyOn(shopService.shopRepository, 'findByPartnerId').mockResolvedValue(null);

      await expect(
        shopService.updateShop('unknown-partner', { shopName: 'New' }),
      ).rejects.toThrow(NotFoundError);
    });
  });
});

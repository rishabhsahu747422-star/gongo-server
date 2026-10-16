'use strict';

const vehicleService = require('../services/vehicle.service');
const storageService = require('../services/storage.service');
const { sendSuccess } = require('../utils/response');

class VehicleController {
  /**
   * POST /api/v1/partner/vehicles
   */
  async createVehicle(req, res, next) {
    try {
      const { partnerId } = req.user;
      const vehicle = await vehicleService.createVehicle({
        partnerId,
        input: req.body,
      });
      sendSuccess(res, vehicle, 201);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/partner/vehicles
   */
  async getVehicles(req, res, next) {
    try {
      const { partnerId } = req.user;
      const result = await vehicleService.getVehicles({
        partnerId,
        query: req.query,
      });
      sendSuccess(res, result, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/partner/vehicles/:vehicleId
   */
  async getVehicleById(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { vehicleId } = req.params;
      const vehicle = await vehicleService.getVehicleById({
        partnerId,
        vehicleId,
      });
      sendSuccess(res, vehicle, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/partner/vehicles/:vehicleId
   */
  async updateVehicle(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { vehicleId } = req.params;
      const updated = await vehicleService.updateVehicle({
        partnerId,
        vehicleId,
        input: req.body,
      });
      sendSuccess(res, updated, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/partner/vehicles/:vehicleId/status
   */
  async updateVehicleStatus(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { vehicleId } = req.params;
      const updated = await vehicleService.updateVehicleStatus({
        partnerId,
        vehicleId,
        input: req.body,
      });
      sendSuccess(res, updated, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * DELETE /api/v1/partner/vehicles/:vehicleId
   */
  async archiveVehicle(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { vehicleId } = req.params;
      const result = await vehicleService.archiveVehicle({
        partnerId,
        vehicleId,
      });
      sendSuccess(res, result, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/partner/vehicles/:vehicleId/images
   */
  async getVehicleImages(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { vehicleId } = req.params;
      const images = await vehicleService.getVehicleImages({
        partnerId,
        vehicleId,
      });
      sendSuccess(res, images, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/partner/vehicles/:vehicleId/images/:imageId/cover
   */
  async setCoverImage(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { vehicleId, imageId } = req.params;
      const result = await vehicleService.setCoverImage({
        partnerId,
        vehicleId,
        imageId,
      });
      sendSuccess(res, result, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * DELETE /api/v1/partner/vehicles/:vehicleId/images/:imageId
   */
  async deleteVehicleImage(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { vehicleId, imageId } = req.params;
      const result = await vehicleService.deleteVehicleImage({
        partnerId,
        vehicleId,
        imageId,
      });
      sendSuccess(res, result, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/partner/vehicles/:vehicleId/images/:imageId/replace
   */
  async replaceVehicleImage(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { vehicleId, imageId } = req.params;
      const result = await storageService.presignUpload({
        partnerId,
        input: {
          ...req.body,
          entityType: 'VEHICLE_IMAGE',
          purpose: 'VEHICLE_IMAGE',
          vehicleId,
          replacesImageId: imageId,
        },
      });
      sendSuccess(res, result, 201);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/partner/vehicles/:vehicleId/documents
   */
  async getVehicleDocuments(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { vehicleId } = req.params;
      const documents = await vehicleService.getVehicleDocuments({
        partnerId,
        vehicleId,
      });
      sendSuccess(res, documents, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/partner/vehicles/:vehicleId/documents or POST /api/v1/partner/vehicle-documents
   */
  async createVehicleDocument(req, res, next) {
    try {
      const { partnerId } = req.user;
      const vehicleId = req.params.vehicleId || req.body.vehicleId || req.body.vehicle_id;
      const document = await vehicleService.createVehicleDocument({
        partnerId,
        input: { ...req.body, vehicleId },
      });
      sendSuccess(res, document, 201);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/partner/vehicle-documents/:id
   */
  async getVehicleDocumentById(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { id } = req.params;
      const document = await vehicleService.getVehicleDocumentById({
        partnerId,
        documentId: id,
      });
      sendSuccess(res, document, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * DELETE /api/v1/partner/vehicles/:vehicleId/documents/:documentId
   */
  async deleteVehicleDocument(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { vehicleId, documentId } = req.params;
      const result = await vehicleService.deleteVehicleDocument({
        partnerId,
        vehicleId,
        documentId,
      });
      sendSuccess(res, result, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/partner/vehicles/:vehicleId/history
   */
  async getVehicleHistory(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { vehicleId } = req.params;
      const result = await vehicleService.getVehicleRentalHistory({
        partnerId,
        vehicleId,
      });
      sendSuccess(res, result, 200);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new VehicleController();

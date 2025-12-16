import { toast } from '../utils/toast.js';

/**
 * Compass rotation functionality
 * 
 * Rotation Modes:
 * - "track-up": Map rotates so your heading direction is always "up" on screen
 * - "north-up": Map stays fixed with north at top (compass needle shows heading)
 * 
 * How it works:
 * - Device heading: 0° = North, 90° = East, 180° = South, 270° = West
 * - For track-up: rotate map by -heading so your direction faces up
 * - Compass needle always points toward true north on screen
 */
export class CompassController {
  constructor() {
    this.isRotationEnabled = false;
    this.currentHeading = 0;
    this.smoothedHeading = 0;
    this.dependencies = {};
    this.orientationHandler = null;
    this.smoothingFactor = 0.3; // Lower = smoother but slower response
    this.lastUpdateTime = 0;
    this.updateInterval = 50; // Minimum ms between updates (20fps)
    
    // Calibration offset - adjust if compass is consistently off
    // Positive values rotate clockwise, negative counter-clockwise
    // Set via: window.compassController.calibrationOffset = 90;
    this.calibrationOffset = 0;
    
    // Debug mode - enable via: window.compassController.debug = true;
    this.debug = false;
  }

  setDependencies(deps) {
    this.dependencies = deps;
  }

  initialize() {
    this.setupToggleButton();
    this.checkDeviceSupport();
    console.log('🧭 Compass controller initialized');
  }

  setupToggleButton() {
    const toggleBtn = document.getElementById('toggleBtn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        this.toggleRotation();
      });
    }
  }

  async checkDeviceSupport() {
    if (!window.DeviceOrientationEvent) {
      console.warn('🧭 Device orientation not supported');
      return false;
    }

    // For iOS 13+, request permission
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const permission = await DeviceOrientationEvent.requestPermission();
        return permission === 'granted';
      } catch (error) {
        console.error('🧭 Permission request failed:', error);
        return false;
      }
    }

    return true;
  }

  async toggleRotation() {
    if (!await this.checkDeviceSupport()) {
      toast.warning('Compass rotation requires device orientation access. Please enable it in browser settings.');
      return;
    }

    if (this.isRotationEnabled) {
      this.disableRotation();
    } else {
      this.enableRotation();
    }
  }

  enableRotation() {
    if (this.isRotationEnabled) return;

    this.orientationHandler = (event) => {
      this.handleOrientationChange(event);
    };

    // Use 'deviceorientationabsolute' if available (gives true north on Android)
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', this.orientationHandler);
      console.log('🧭 Using deviceorientationabsolute (true north)');
    } else {
      window.addEventListener('deviceorientation', this.orientationHandler);
      console.log('🧭 Using deviceorientation (may be magnetic north)');
    }
    
    this.isRotationEnabled = true;
    this.updateToggleButton();
    toast.success('Compass rotation enabled');
    console.log('🧭 Compass rotation enabled');
  }

  disableRotation() {
    if (!this.isRotationEnabled) return;

    if (this.orientationHandler) {
      window.removeEventListener('deviceorientationabsolute', this.orientationHandler);
      window.removeEventListener('deviceorientation', this.orientationHandler);
      this.orientationHandler = null;
    }

    this.isRotationEnabled = false;
    
    // Reset rotation
    this.resetMapRotation();
    this.resetCompassRotation();
    
    this.updateToggleButton();
    toast.show('Compass rotation disabled');
    console.log('🧭 Compass rotation disabled');
  }

  /**
   * Handle device orientation change
   * Calculates compass heading from device sensors
   */
  handleOrientationChange(event) {
    if (!this.isRotationEnabled) return;

    // Throttle updates for performance
    const now = Date.now();
    if (now - this.lastUpdateTime < this.updateInterval) return;
    this.lastUpdateTime = now;

    let heading = this.calculateHeading(event);
    
    if (heading !== null) {
      // Apply calibration offset
      heading = (heading + this.calibrationOffset + 360) % 360;
      
      // Apply smoothing to reduce jitter
      this.smoothedHeading = this.smoothAngle(this.smoothedHeading, heading, this.smoothingFactor);
      this.currentHeading = this.smoothedHeading;
      this.updateRotations();
    }
  }

  /**
   * Calculate compass heading from device orientation event
   * Returns heading in degrees: 0 = North, 90 = East, 180 = South, 270 = West
   */
  calculateHeading(event) {
    let heading = null;

    // iOS Safari: webkitCompassHeading gives direct compass heading
    if (typeof event.webkitCompassHeading !== 'undefined' && event.webkitCompassHeading !== null) {
      heading = event.webkitCompassHeading;
      if (this.debug) console.log('🧭 iOS heading:', heading.toFixed(1));
    }
    // Android/Other: Calculate from alpha, beta, gamma
    else if (event.alpha !== null && event.alpha !== undefined) {
      
      if (event.absolute === true || event.type === 'deviceorientationabsolute') {
        // Absolute orientation - alpha should be compass heading
        // But alpha = 0 means pointing to magnetic/true north
        // Heading convention: 0 = North, 90 = East
        heading = event.alpha;
      } else {
        // Relative orientation - try to calculate proper heading
        // Some devices need adjustment based on beta/gamma
        heading = this.calculateAndroidHeading(event);
      }
      
      // Adjust for screen orientation if device is in landscape
      heading = this.adjustForScreenOrientation(heading);
      
      if (this.debug) {
        console.log('🧭 Android - alpha:', event.alpha?.toFixed(1), 
                    'beta:', event.beta?.toFixed(1), 
                    'gamma:', event.gamma?.toFixed(1),
                    'absolute:', event.absolute,
                    '=> heading:', heading?.toFixed(1));
      }
    }

    return heading;
  }

  /**
   * Calculate heading for Android devices
   * Uses alpha, beta, gamma to compute compass heading
   */
  calculateAndroidHeading(event) {
    const alpha = event.alpha || 0;
    const beta = event.beta || 0;
    const gamma = event.gamma || 0;
    
    // Method 1: Simple alpha inversion (works on some devices)
    // alpha goes counterclockwise, compass heading goes clockwise
    let heading = (360 - alpha) % 360;
    
    // Method 2: If device is tilted significantly, adjust for tilt
    // This helps when phone isn't held flat
    if (Math.abs(beta) > 45 || Math.abs(gamma) > 45) {
      // Device is tilted - use more complex calculation
      // Convert to radians
      const alphaRad = alpha * (Math.PI / 180);
      const betaRad = beta * (Math.PI / 180);
      const gammaRad = gamma * (Math.PI / 180);
      
      // Rotation matrix calculation for tilted device
      const cA = Math.cos(alphaRad);
      const sA = Math.sin(alphaRad);
      const cB = Math.cos(betaRad);
      const sB = Math.sin(betaRad);
      const cG = Math.cos(gammaRad);
      const sG = Math.sin(gammaRad);
      
      // Compass heading accounting for tilt
      const Vx = -cA * sG - sA * sB * cG;
      const Vy = -sA * sG + cA * sB * cG;
      
      heading = Math.atan2(Vx, Vy) * (180 / Math.PI);
      heading = (heading + 360) % 360;
    }
    
    return heading;
  }

  /**
   * Adjust heading based on screen orientation
   * Needed when device is held in landscape mode
   */
  adjustForScreenOrientation(heading) {
    const screenOrientation = window.screen?.orientation?.angle || 
                              window.orientation || 
                              0;
    
    // Subtract screen rotation from heading
    heading = (heading - screenOrientation + 360) % 360;
    
    return heading;
  }

  /**
   * Smooth angle transitions to reduce jitter
   * Handles the 0/360 wraparound correctly
   */
  smoothAngle(current, target, factor) {
    // Calculate the shortest angular distance
    let diff = target - current;
    
    // Handle wraparound (e.g., going from 350° to 10°)
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    
    // Apply smoothing
    let smoothed = current + diff * factor;
    
    // Normalize to 0-360
    return ((smoothed % 360) + 360) % 360;
  }

  updateRotations() {
    this.updateMapRotation();
    this.updateCompassRotation();
  }

  /**
   * Update map rotation for "track-up" mode
   * Rotates map so your heading direction is "up" on screen
   */
  updateMapRotation() {
    if (!this.dependencies.map || !this.isRotationEnabled) return;

    try {
      // For track-up mode: rotate map opposite to heading
      // So if you're facing east (90°), map rotates -90° to put east at top
      this.dependencies.map.setRotation(this.currentHeading);
    } catch (error) {
      console.error('🧭 Failed to update map rotation:', error);
    }
  }

  /**
   * Update compass needle to always point toward true north on screen
   */
  updateCompassRotation() {
    const needleElement = document.getElementById('compass-needle');
    if (!needleElement) return;

    // In track-up mode, the map has rotated by -heading
    // So north on the map is now at angle = heading
    // The needle should point to where north IS on screen
    // If facing east (heading 90), north is to your left (-90° from top)
    const needleRotation = -this.currentHeading;
    needleElement.style.transform = `rotate(${needleRotation}deg)`;
  }

  updateToggleButton() {
    const toggleBtn = document.getElementById('toggleBtn');
    if (!toggleBtn) return;

    if (this.isRotationEnabled) {
      toggleBtn.style.background = '#4CAF50';
      toggleBtn.title = 'Disable Rotation';
      toggleBtn.setAttribute('aria-pressed', 'true');
    } else {
      toggleBtn.style.background = 'rgba(0, 0, 0, 0.8)';
      toggleBtn.title = 'Enable Rotation';
      toggleBtn.setAttribute('aria-pressed', 'false');
    }
  }

  resetMapRotation() {
    if (!this.dependencies.map) return;

    try {
      this.dependencies.map.resetRotation();
    } catch (error) {
      console.error('🧭 Failed to reset map rotation:', error);
    }
  }

  resetCompassRotation() {
    const needleElement = document.getElementById('compass-needle');
    if (!needleElement) return;
    
    needleElement.style.transform = 'rotate(0deg)';
  }

  getCurrentHeading() {
    return this.currentHeading;
  }

  isRotationActive() {
    return this.isRotationEnabled;
  }

  /**
   * Get cardinal direction from heading
   */
  getCardinalDirection() {
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const index = Math.round(this.currentHeading / 45) % 8;
    return directions[index];
  }

  /**
   * Set calibration offset to correct for compass errors
   * @param {number} offset - Offset in degrees (positive = clockwise)
   */
  setCalibrationOffset(offset) {
    this.calibrationOffset = offset;
    console.log(`🧭 Calibration offset set to ${offset}°`);
    toast.show(`Compass calibrated: ${offset}° offset`);
  }

  /**
   * Auto-calibrate by setting current direction as north
   * User should face true north when calling this
   */
  calibrateToNorth() {
    // Calculate what offset would make current heading = 0
    this.calibrationOffset = (360 - this.currentHeading + this.calibrationOffset) % 360;
    console.log(`🧭 Calibrated to north. Offset: ${this.calibrationOffset}°`);
    toast.success('Compass calibrated! Current direction set as North.');
  }

  /**
   * Enable debug logging
   */
  enableDebug() {
    this.debug = true;
    console.log('🧭 Debug mode enabled. Heading values will be logged.');
  }

  /**
   * Disable debug logging
   */
  disableDebug() {
    this.debug = false;
    console.log('🧭 Debug mode disabled.');
  }

  cleanup() {
    this.disableRotation();
    console.log('🧭 Compass controller cleaned up');
  }
}

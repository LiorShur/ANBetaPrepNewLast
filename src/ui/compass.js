import { toast } from '../utils/toast.js';

/**
 * Compass rotation functionality
 * 
 * Heading convention: 0° = North, 90° = East, 180° = South, 270° = West
 * (Increases clockwise when viewed from above)
 * 
 * Mode: "Track-up" - Map rotates so your heading direction is always "up" on screen
 */
export class CompassController {
  constructor() {
    this.isRotationEnabled = false;
    this.currentHeading = 0;
    this.smoothedHeading = 0;
    this.dependencies = {};
    this.orientationHandler = null;
    this.smoothingFactor = 0.15; // Lower = smoother but slower response
    this.lastUpdateTime = 0;
    this.updateInterval = 50; // Minimum ms between updates
    
    // Lock to one event type to prevent jumping
    this.eventType = null; // Will be set to 'absolute' or 'relative'
    
    // Calibration offset - adjust if compass is consistently off
    this.calibrationOffset = 0;
    
    // Debug mode
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

    // Reset event type lock
    this.eventType = null;

    // Try absolute first (preferred - gives true north)
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', this.orientationHandler);
      console.log('🧭 Listening for deviceorientationabsolute');
    }
    
    // Also listen for regular deviceorientation as fallback
    window.addEventListener('deviceorientation', this.orientationHandler);
    console.log('🧭 Listening for deviceorientation');
    
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
    this.eventType = null;
    
    // Reset rotation
    this.resetMapRotation();
    this.resetCompassRotation();
    
    this.updateToggleButton();
    toast.show('Compass rotation disabled');
    console.log('🧭 Compass rotation disabled');
  }

  /**
   * Handle device orientation change
   */
  handleOrientationChange(event) {
    if (!this.isRotationEnabled) return;

    // Lock to first event type we receive to prevent jumping
    const isAbsolute = event.type === 'deviceorientationabsolute' || event.absolute === true;
    const eventType = isAbsolute ? 'absolute' : 'relative';
    
    // Once we get absolute, stick with it (it's more reliable)
    if (this.eventType === null) {
      this.eventType = eventType;
      console.log(`🧭 Locked to ${eventType} orientation`);
    } else if (this.eventType === 'absolute' && eventType === 'relative') {
      // Ignore relative events once we've locked to absolute
      return;
    } else if (this.eventType === 'relative' && eventType === 'absolute') {
      // Upgrade from relative to absolute if it becomes available
      this.eventType = 'absolute';
      console.log('🧭 Upgraded to absolute orientation');
    }

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
    // It already follows the convention: 0=N, 90=E, 180=S, 270=W
    if (typeof event.webkitCompassHeading !== 'undefined' && event.webkitCompassHeading !== null) {
      heading = event.webkitCompassHeading;
    }
    // Android/Other: Use alpha value
    else if (event.alpha !== null && event.alpha !== undefined) {
      // Alpha measures rotation around z-axis
      // alpha = 0 means device top points to north
      // alpha INCREASES counter-clockwise (when viewed from above)
      // So: alpha = 0 → N, alpha = 90 → W, alpha = 180 → S, alpha = 270 → E
      
      // To convert to compass heading (0=N, 90=E, increases clockwise):
      // heading = (360 - alpha) % 360
      // This gives: alpha=0 → 0(N), alpha=90 → 270(W), alpha=180 → 180(S), alpha=270 → 90(E) ✓
      
      // Wait, that's still wrong. Let me reconsider...
      // Actually on most Android devices with deviceorientationabsolute:
      // alpha = 0 means north, and alpha increases as device rotates LEFT (counter-clockwise)
      
      // The user reports: turning east (right/clockwise), heading DECREASES from 360
      // This means we're outputting (360 - alpha), and alpha is INCREASING when turning right
      // So alpha increases clockwise on their device
      
      // For such devices, heading = alpha directly (no inversion needed)
      heading = event.alpha;
      
      // Adjust for screen orientation
      heading = this.adjustForScreenOrientation(heading);
    }

    return heading;
  }

  /**
   * Adjust heading based on screen orientation (landscape/portrait)
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
   * Update map rotation
   * Rotates map so your heading direction is "up" on screen
   */
  updateMapRotation() {
    if (!this.dependencies.map || !this.isRotationEnabled) return;

    try {
      // Rotate map by negative heading so your direction faces up
      this.dependencies.map.setRotation(this.currentHeading);
    } catch (error) {
      console.error('🧭 Failed to update map rotation:', error);
    }
  }

  /**
   * Update compass needle to point toward north on screen
   */
  updateCompassRotation() {
    const needleElement = document.getElementById('compass-needle');
    if (!needleElement) return;

    // Needle points to where north is on screen
    // If map is rotated by -heading, north is at angle = heading from top
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
    this.calibrationOffset = ((offset % 360) + 360) % 360;
    console.log(`🧭 Calibration offset set to ${this.calibrationOffset}°`);
  }

  /**
   * Adjust calibration by adding degrees
   */
  adjustCalibration(degrees) {
    this.calibrationOffset = ((this.calibrationOffset + degrees) % 360 + 360) % 360;
    console.log(`🧭 Calibration adjusted to ${this.calibrationOffset}°`);
  }

  /**
   * Auto-calibrate by setting current direction as north
   */
  calibrateToNorth() {
    // What offset would make current heading = 0?
    // If current shows 90 but should be 0, offset should be -90 (or +270)
    const currentRaw = (this.currentHeading - this.calibrationOffset + 360) % 360;
    this.calibrationOffset = (360 - currentRaw) % 360;
    console.log(`🧭 Calibrated to north. Offset: ${this.calibrationOffset}°`);
    toast.success(`Compass calibrated! Offset: ${this.calibrationOffset.toFixed(0)}°`);
  }

  /**
   * Get current event type being used
   */
  getEventType() {
    return this.eventType || 'none';
  }

  cleanup() {
    this.disableRotation();
    console.log('🧭 Compass controller cleaned up');
  }
}

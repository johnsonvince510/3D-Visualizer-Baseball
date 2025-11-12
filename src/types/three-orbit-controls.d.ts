declare module "three/examples/jsm/controls/OrbitControls.js" {
  import * as THREE from "three";

  export class OrbitControls {
    constructor(object: any, domElement?: HTMLElement);
    object: any;
    domElement: HTMLElement;
    target: THREE.Vector3;
    enableDamping: boolean;
    dampingFactor: number;
    enableZoom: boolean;
    minDistance: number;
    maxDistance: number;
    minPolarAngle: number;
    maxPolarAngle: number;
    update(): void;
    dispose(): void;
    addEventListener(type: string, listener: (...args: any[]) => void): void;
    removeEventListener(type: string, listener: (...args: any[]) => void): void;
  }
}

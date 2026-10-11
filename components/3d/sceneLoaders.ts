/**
 * Scene modules (§123, §124): each major scene is a separate dynamically imported chunk.
 * Kept free of React Three Fiber so the UI can prefetch scenes without pulling the 3D runtime.
 */
import type { ComponentType } from 'react';
import type { SceneId, Stage } from '@/types';

export interface SceneProps {
  stage: Stage;
}

type Loader = () => Promise<{ default: ComponentType<SceneProps> }>;

export const SCENE_LOADERS: Record<SceneId, Loader> = {
  fab: () => import('./scenes/FabScene'),
  materials: () => import('./scenes/MaterialsScene'),
  crystal: () => import('./scenes/CrystalScene'),
  ingot: () => import('./scenes/IngotScene'),
  finishing: () => import('./scenes/FinishingScene'),
  robot: () => import('./scenes/RobotScene'),
  thermal: () => import('./scenes/ThermalScene'),
  deposition: () => import('./scenes/DepositionScene'),
  track: () => import('./scenes/TrackScene'),
  lithography: () => import('./scenes/LithographyScene'),
  etch: () => import('./scenes/EtchScene'),
  implant: () => import('./scenes/ImplantScene'),
  cmp: () => import('./scenes/CMPScene'),
  cycle: () => import('./scenes/CycleScene'),
  transistor: () => import('./scenes/TransistorScene'),
  interconnect: () => import('./scenes/InterconnectScene'),
  metrology: () => import('./scenes/MetrologyScene'),
  inspection: () => import('./scenes/InspectionScene'),
  probe: () => import('./scenes/ProbeScene'),
  dicing: () => import('./scenes/DicingScene'),
  packaging: () => import('./scenes/PackagingScene'),
  finaltest: () => import('./scenes/FinalTestScene'),
  shipping: () => import('./scenes/ShippingScene'),
  globe: () => import('./scenes/GlobeScene'),
  supplychain: () => import('./scenes/SupplyChainScene'),
  controlroom: () => import('./scenes/ControlRoomScene'),
  utilities: () => import('./scenes/UtilitiesScene'),
  system: () => import('./scenes/SystemScene'),
  scale: () => import('./scenes/ScaleScene'),
};

const prefetched = new Set<string>();
export function prefetchScene(id: SceneId) {
  if (prefetched.has(id)) return;
  prefetched.add(id);
  SCENE_LOADERS[id]().catch(() => prefetched.delete(id));
}


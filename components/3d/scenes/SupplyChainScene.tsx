'use client';
import type { SceneProps } from '../SceneSwitcher';
import { Lighting, CleanroomBay } from '../environments';

/** Placeholder — replaced by the full scene implementation. */
export default function SupplyChainScene({ stage }: SceneProps) {
  void stage;
  return (
    <>
      <Lighting env="cleanroom" />
      <CleanroomBay />
    </>
  );
}

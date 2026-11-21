# Choosing a scan format

**Try a colored PLY from RTAB-Map first.** Its Canadian iOS listing identifies it as free, lists PLY export, and specifies a LiDAR sensor for 3D reconstruction. Krishna and Anish can export a real hallway before writing a capture app. Arielle can start with the synthetic PLY today. Choose the guest format after the team opens a real scan on a second phone. [RTAB-Map for iOS](https://apps.apple.com/ca/app/rtab-map-3d-lidar-scanner/id1564774365) · [Venue fixture](../fixtures/README.md)

| Candidate | What to export | What the guest sees |
| --- | --- | --- |
| Colored point cloud (`.ply`) | Export points with XYZ positions and red, green, and blue vertex properties. Record the encoding because the fixture uses ASCII and the phone may write binary. | A 3D view made of colored samples. With Three.js, load the geometry with `PLYLoader` and render `Points` with vertex colors enabled. [PLYLoader](https://threejs.org/docs/pages/PLYLoader.html) · [Points](https://threejs.org/docs/pages/Points.html) |
| Textured mesh (`.glb`) | Try a mesh export with geometry and textures embedded in one GLB. 3d Scanner App lists GLB export and in-app purchases. Check export availability on the device. | Solid surfaces can preserve the appearance of signs and doors between sample points. Load the scene with `GLTFLoader` and check that materials display on mobile. [3d Scanner App](https://apps.apple.com/ca/app/3d-scanner-app/id1419913995) · [GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html) |

Polycam is another option for a LiDAR mesh. Its free iOS tier includes Space Mode and glTF export. Check the output package for embedded textures or companion files before trying a single-file upload. Polycam lists point cloud export under Business and Enterprise. [Space Mode](https://learn.poly.cam/hc/en-us/articles/36655587097620-How-to-Use-Space-Mode-with-LiDAR-enabled-devices) · [Export options by plan](https://learn.poly.cam/hc/en-us/articles/27756102599572-What-File-Types-Can-Polycam-Export)

## First phone test

1. **Krishna and Anish** record a short corridor with a turn, a colored landmark, and two points a measured distance apart. Record phone model, capture app and mode, file format, size, and export time. For custom capture, Apple's ARKit sample shows how to locate points using scene depth and color them from the corresponding camera image. [Apple's depth-cloud sample](https://developer.apple.com/documentation/arkit/displaying-a-point-cloud-using-scene-depth)
2. **Sam** accepts the organizer's exported asset and returns the Path App share link. The first upload only needs the scan. When adding navigation, align the asset and waypoints to the same right-handed event frame in meters, with +Y up and −Z forward from the entrance. Check the measured distance and the direction of the turn. [Venue coordinate convention](../fixtures/README.md)
3. **Arielle** opens the link signed out on a second phone. Time from opening the link to an interactive view. Orbit the scan, identify the turn and landmark, then reload the link. Record browser, phone, network, load time, and whether the landmark was recognizable.

Use the PLY for the demo if it passes that walkthrough. If sparse points obscure the landmark or the scan is too slow to navigate, compare a cropped or downsampled PLY and a textured GLB of the same section. Record the chosen export preset and observed measurements in the capture PR.

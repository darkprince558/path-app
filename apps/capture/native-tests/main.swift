import AppKit
import Foundation
import simd

// Export the same Swift geometry as the iPhone, with a measured 2 m wall and a floor triangle.
let dest = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
let bitmap = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: 64, pixelsHigh: 64, bitsPerSample: 8, samplesPerPixel: 3,
  hasAlpha: false, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 192, bitsPerPixel: 24)!
let pixels = bitmap.bitmapData!
for y in 0..<64 {
  for x in 0..<64 {
    let i = y * bitmap.bytesPerRow + 3 * x
    pixels[i] = x < 32 ? 235 : 24
    pixels[i + 1] = y < 32 ? 40 : 205
    pixels[i + 2] = x < 32 ? 28 : 224
  }
}
let image = dest.appendingPathComponent("view.jpg")
try bitmap.representation(using: .jpeg, properties: [:])!.write(to: image)
let intrinsics = simd_float3x3(columns: (SIMD3(48, 0, 0), SIMD3(0, 48, 0), SIMD3(32, 32, 1)))
let photo = ScanPhoto(
  url: image, worldToCamera: matrix_identity_float4x4, intrinsics: intrinsics, size: SIMD2(64, 64),
  depth: Array(repeating: 2, count: 16), depthSize: SIMD2(4, 4))
let verts: [SIMD3<Float>] = [
  SIMD3(-1, -1, -2), SIMD3(1, -1, -2), SIMD3(1, 1, -2), SIMD3(-1, 1, -2), SIMD3(-1, -1, -1),
  SIMD3(1, -1, -1),
]
let faces = [
  SurfaceFace(indices: SIMD3(0, 1, 2), classification: 1),
  SurfaceFace(indices: SIMD3(0, 2, 3), classification: 1),
  SurfaceFace(indices: SIMD3(0, 4, 5), classification: 2),
  SurfaceFace(indices: SIMD3(99, 1, 2), classification: 0),
]
var points = PointCloud()
for p in verts { points.add(p, color: SIMD3(126, 191, 150)) }
var mesh = NativeGLB()
let out = try mesh.write(
  chunks: [SurfaceChunk(vertices: verts, faces: faces)], cloud: points, photos: [photo],
  to: dest.appendingPathComponent("scene.glb"))
precondition(
  out.triangles == 3 && out.texturedTriangles == 2 && out.classes == ["wall": 2, "floor": 1])
precondition(abs(simd_distance(verts[0], verts[1]) - 2) < 0.00001)
let missingDepth = ScanPhoto(
  url: image, worldToCamera: photo.worldToCamera, intrinsics: intrinsics, size: photo.size,
  depth: [], depthSize: .zero)
precondition(missingDepth.project(SIMD3(0, 0, -2)) == nil)
precondition(photo.project(SIMD3(0, 0, -3)) == nil)
precondition(photo.project(SIMD3(0, 0, 2)) == nil)
precondition(photo.project(SIMD3(0, 0, -2))?.uv == SIMD2<Float>(0.5, 0.5))
try points.binaryPLY().write(to: dest.appendingPathComponent("points.ply"))
var cloud = NativeGLB()
let sparse = try cloud.write(
  chunks: [], cloud: points, photos: [], to: dest.appendingPathComponent("sparse.glb"))
precondition(sparse.triangles == 0)
let token = String(repeating: "a", count: 40)
for host in ["scanner.local", "10.0.0.1", "192.168.0.8", "172.31.255.2"] {
  let address = try MacAddress("https://\(host):8643/record#key=\(token)")
  precondition(address.origin.host == host)
}
for host in [
  "10.foo.0.0.1.example.com", "10.0.0.1.example.com", "10.0.0.01", "192.169.0.1", "172.32.0.1",
  "example.com",
] { precondition((try? MacAddress("https://\(host):8643/record#key=\(token)")) == nil) }
print(
  "Native metric mesh, signed axes, occlusion fallback, point export and organizer validation passed."
)

// Save the same inputs a finished phone take has. A tiled wall exercises mobile decimation.
let take = dest.appendingPathComponent("bundle-take", isDirectory: true)
try FileManager.default.createDirectory(at: take, withIntermediateDirectories: true)
let firstJPEG = take.appendingPathComponent("photo-0.jpg")
try Data(contentsOf: image).write(to: firstJPEG)
let secondBitmap = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: 64, pixelsHigh: 64, bitsPerSample: 8, samplesPerPixel: 3,
  hasAlpha: false, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 192, bitsPerPixel: 24)!
let secondPixels = secondBitmap.bitmapData!
for y in 0..<64 {
  for x in 0..<64 {
    let i = y * secondBitmap.bytesPerRow + 3 * x
    secondPixels[i + 1] = y < 32 ? 40 : 205
    secondPixels[i] = x < 27 ? 235 : 24
    secondPixels[i + 2] = x < 27 ? 28 : 224
  }
}
try secondBitmap.representation(using: .jpeg, properties: [:])!.write(
  to: take.appendingPathComponent("photo-7.jpg"))
var grid: [SIMD3<Float>] = []
var wall: [SurfaceFace] = []
var wallCloud = PointCloud()
for row in 0...10 {
  for col in 0...10 {
    let p = SIMD3(Float(col) / 5 - 1, Float(row) / 5 - 1, Float(-2))
    grid.append(p)
    wallCloud.add(p, color: SIMD3(col < 5 ? 235 : 24, row > 5 ? 40 : 205, col < 5 ? 28 : 224))
    if row < 10, col < 10 {
      let i = Int32(row * 11 + col)
      wall.append(SurfaceFace(indices: SIMD3(i, i + 1, i + 12), classification: 1))
      wall.append(SurfaceFace(indices: SIMD3(i, i + 12, i + 11), classification: 1))
    }
  }
}
var denseMesh = NativeGLB()
let stats = try denseMesh.write(
  chunks: [SurfaceChunk(vertices: grid, faces: wall)], cloud: wallCloud,
  photos: [photo], to: take.appendingPathComponent("scene.glb"))
try wallCloud.binaryPLY().write(to: take.appendingPathComponent("points.ply"))
func fixturePose(_ x: Float, _ t: Double, _ tracking: String) -> [String: Any] {
  var matrix = matrix_identity_float4x4
  matrix.columns.3.x = x
  return [
    "t": t, "tracking": tracking,
    "intrinsics": [96, 0, 0, 0, 96, 0, 64, 64, 1], "imageWidth": 128, "imageHeight": 128,
    "cameraToWorld": (0..<4).flatMap { c in (0..<4).map { matrix[c][$0] } },
  ]
}
let poses = [
  fixturePose(0, 0, "limited"), fixturePose(0, 0.25, "normal"), fixturePose(0.2, 1.25, "normal"),
]
try JSONSerialization.data(withJSONObject: poses).write(
  to: take.appendingPathComponent("camera-poses.json"))
let selected: [[String: Any]] = [
  ["camera": poses[1], "jpeg": "photo-0.jpg"], ["camera": poses[2], "jpeg": "photo-7.jpg"],
]
try JSONSerialization.data(withJSONObject: selected).write(
  to: take.appendingPathComponent("keyframes.json"))
let record = ScanRecord(
  id: UUID(uuidString: "6D8C1359-2480-4493-89B8-39BE20CC6FC9")!,
  created: Date(timeIntervalSince1970: 1_795_284_000), duration: 1.25,
  mode: "Synthetic wall fixture", pointCount: wallCloud.count, triangles: stats.triangles,
  photoFaces: stats.texturedTriangles, poseCount: poses.count, gyroCount: 0, classes: stats.classes,
  hasVideo: false, partial: false, deviceModel: "synthetic wall fixture", deviceOSVersion: "synthetic iOS 18.6")
try JSONEncoder().encode(record).write(to: take.appendingPathComponent("scan.json"))
try CaptureBundle.write(
  take: take, record: record, to: dest.appendingPathComponent("capture"))
print("Exported the LiDAR bundle using the scanner writer.")

// A second export must retain the device UUID, stable frame IDs and checksums.
let repeatBundle = dest.appendingPathComponent("capture-repeat")
try CaptureBundle.write(take: take, record: record, to: repeatBundle)
for name in ["manifest.json", "frames.json"] {
  let first = try Data(contentsOf: dest.appendingPathComponent("capture/" + name))
  let repeated = try Data(contentsOf: repeatBundle.appendingPathComponent(name))
  precondition(first == repeated, "Repeat export changed identities or checksums")
}
let exportedIndex = try JSONSerialization.jsonObject(
  with: Data(contentsOf: dest.appendingPathComponent("capture/frames.json"))) as! [String: Any]
precondition(exportedIndex["version"] as? Int == 1)
precondition(exportedIndex["captureId"] as? String == record.id.uuidString.lowercased())
let exportedFrames = exportedIndex["frames"] as! [[String: Any]]
precondition(exportedFrames.map { $0["id"] as! String } == ["frame-0000", "frame-0007"])
precondition(exportedFrames[1]["timestampSeconds"] as? Double == 1.25)
for frame in exportedFrames {
  precondition(frame["width"] as? Int == 64 && frame["height"] as? Int == 64)
  let calibration = frame["intrinsics"] as! [String: Any]
  precondition(calibration["fx"] as? Double == 48 && calibration["cx"] as? Double == 32)
}

// Legacy saved takes omit OS/calibration; preserve compatibility without inventing metadata.
var legacyRecord = record
legacyRecord.deviceModel = nil
legacyRecord.deviceOSVersion = nil
let originalKeyframes = try Data(contentsOf: take.appendingPathComponent("keyframes.json"))
var legacyKeyframes = selected
for i in legacyKeyframes.indices {
  var camera = legacyKeyframes[i]["camera"] as! [String: Any]
  for key in ["intrinsics", "imageWidth", "imageHeight"] { camera.removeValue(forKey: key) }
  legacyKeyframes[i]["camera"] = camera
}
try JSONSerialization.data(withJSONObject: legacyKeyframes).write(to: take.appendingPathComponent("keyframes.json"))
let legacyBundle = dest.appendingPathComponent("capture-legacy")
try CaptureBundle.write(take: take, record: legacyRecord, to: legacyBundle)
try originalKeyframes.write(to: take.appendingPathComponent("keyframes.json"))
let legacyManifest = try JSONSerialization.jsonObject(with: Data(contentsOf: legacyBundle.appendingPathComponent("manifest.json"))) as! [String: Any]
let legacyDevice = legacyManifest["device"] as! [String: String]
precondition(legacyDevice["osVersion"] == "unknown (legacy scan)")
let legacyIndex = try JSONSerialization.jsonObject(with: Data(contentsOf: legacyBundle.appendingPathComponent("frames.json"))) as! [String: Any]
precondition((legacyIndex["frames"] as! [[String: Any]]).allSatisfy { $0["intrinsics"] == nil })
print("Stable device IDs, frame dimensions, scaled intrinsics and legacy export passed.")

// A three-minute L-shaped replay crosses the old time and face budgets. A
// tracking loss must leave a gap and the camera path alone must never paint coverage.
var accumulated = WalkMap(), sectionMap = WalkMap()
var walkSections = 0, began = 0
for second in 0...180 {
  let here = SIMD2<Float>(Float(min(second,90)) * 0.5, Float(max(0,second-90)) * 0.5)
  sectionMap.locate(here, forward: SIMD2(1,0), at: Double(second), normal: !(74...79).contains(second))
  if second == 4 { precondition(sectionMap.tiles.isEmpty) }
  if second >= 5 && sectionMap.tracked {
    sectionMap.observe(SIMD3(here.x, 0, here.y + 1), cameraHeight: 1.5)
  }
  if SectionBudget.shouldSave(seconds: Double(second-began), points: 130_000, faces: 115_000) || second == 180 {
    accumulated.include(sectionMap)
    sectionMap = sectionMap.nextSection()
    walkSections += 1
    began = second
  }
}
precondition(walkSections > 5 && accumulated.distance > 85 && accumulated.distance < 89)
precondition(accumulated.tiles.count > 150)
precondition(!accumulated.tiles.contains(SIMD2(150,4)))  // unseen during tracking loss
precondition(accumulated.tracks.allSatisfy { run in zip(run,run.dropFirst()).allSatisfy { simd_distance($0,$1) <= 0.51 } })
try accumulated.write(to: dest)
let reopenedMap = try WalkMap.read(from: dest)
precondition(reopenedMap.tiles == accumulated.tiles && reopenedMap.tracks == accumulated.tracks)
let almostAffine: [Float] = [1,0,0,0, 0,1,0,0, 0,0,1,0, 3,2,1,0.99999994]
let exactPose = try CaptureBundle.affinePose(almostAffine)
precondition(exactPose[15] == 1 && exactPose[12] == 3)
var projective = almostAffine; projective[3] = 0.1
precondition((try? CaptureBundle.affinePose(projective)) == nil)
print("180-second route replay: \(walkSections) sections, \(accumulated.distance) tracked metres; map survived reload.")

let replayScript = try ReplayScript(contentsOf: URL(fileURLWithPath: "apps/capture/PathCapture/hallway.json"))
let replay = ReplaySource(script: replayScript)
replay.advance(to: 4)
precondition(replay.liveMap.tiles.isEmpty && replay.tracking == .normal)
replay.advance(to: 76)
precondition(replay.tracking == .limited && !replay.liveMap.tracked)
replay.advance(to: 180)
replay.stop(reason: nil)
replay.stop(reason: nil)
precondition(replay.phase == .finished && replay.savedSections == walkSections)
precondition(replay.liveMap.distance == accumulated.distance && replay.liveMap.tiles == accumulated.tiles)

let viewport = CGSize(width: 320, height: 160)
var drawingCamera = MapCamera(centre: CGPoint(x: -3, y: 7), metresPerPoint: 0.05,
                              rotation: 0.71, viewport: viewport)
let finger = CGPoint(x: 54, y: 33)
let anchor = drawingCamera.unproject(finger)
func close(_ lhs: CGPoint, _ rhs: CGPoint) -> Bool { hypot(lhs.x - rhs.x, lhs.y - rhs.y) < 0.00001 }
precondition(close(drawingCamera.project(anchor), finger))
let movedFinger = CGPoint(x: 92, y: 51)
drawingCamera.change(from: finger, to: movedFinger, zoom: 1.65, turn: 0.4)
precondition(close(drawingCamera.project(anchor), movedFinger))
drawingCamera.change(from: finger, to: finger, zoom: 1e8, turn: 0)
precondition(abs(drawingCamera.metresPerPoint * viewport.width - 2) < 0.00001)
drawingCamera.change(from: finger, to: finger, zoom: 1e-8, turn: 0)
precondition(abs(drawingCamera.metresPerPoint * viewport.width - 200) < 0.00001)
let corridorBounds = CGRect(x: -35, y: 10, width: 84, height: 9)
let fit = MapCamera.fitting(corridorBounds, rotation: 1.1, viewport: viewport)
for x in [corridorBounds.minX, corridorBounds.maxX] {
  for y in [corridorBounds.minY, corridorBounds.maxY] {
    precondition(CGRect(origin: .zero, size: viewport).contains(fit.project(CGPoint(x: x, y: y))))
  }
}
var adjacentTiles = WalkMap()
adjacentTiles.tiles = [SIMD2(-2,3), SIMD2(-1,3), SIMD2(1,3)]
let layer = WalkLayer(adjacentTiles)
precondition(layer.rows[3]?.count == 2 && layer.rows[3]?.first?.width == 0.5)
print("Map projection, pivot, zoom limits, rotated fit and tile runs passed.")

// Viewed from a phone looking sideways, a flat depth image is a wall. The
// same image looking down is floor. Direction must follow walking, not yaw.
func guidanceFrame(_ at: SIMD3<Float>, facing: SIMD3<Float>, depth: Float = 1.5) -> SideObservation {
  var transform = simd_float4x4(simd_quatf(from: SIMD3(0, 0, -1), to: facing))
  transform.columns.3 = SIMD4(at, 1)
  return SideObservation.sample(width: 96, height: 80, focal: SIMD2(72, 72),
                                center: SIMD2(48, 40), camera: transform) { _,_ in depth }
}
let guideRight = SIMD3<Float>(1, 0, 0), guideFloor = SIMD3<Float>(0, -1, 0)
precondition(guidanceFrame(.zero, facing: guideFloor).upright.isEmpty)
precondition(!guidanceFrame(.zero, facing: guideRight).upright.isEmpty)

for sign: Float in [-1, 1] {
  var guide = SideGuidance()
  var position = SIMD3<Float>.zero
  for step in 0...12 {
    position.z = sign * Float(step) * 0.25
    guide.update(position: position, at: Double(step)*0.4, frame: guidanceFrame(position, facing: guideRight))
  }
  precondition(guide.cue == (sign < 0 ? .left : .right))
  // Hold the phone in the same place and sweep onto the omitted surface.
  for step in 13...15 {
    guide.update(position: position, at: Double(step)*0.4, frame: guidanceFrame(position, facing: -guideRight))
  }
  precondition(guide.cue == nil)
}
var openGuide = SideGuidance(), floorGuide = SideGuidance(), stillGuide = SideGuidance()
for step in 0...16 {
  let position = SIMD3<Float>(0, 0, -Float(step)*0.25)
  let time = Double(step)*0.4
  let wallFrame = guidanceFrame(position, facing: guideRight)
  let openFrame = guidanceFrame(position, facing: -guideRight, depth: 4.8)
  var both = wallFrame
  both.open.formUnion(openFrame.open)
  precondition(!both.open.isEmpty)
  openGuide.update(position: position, at: time, frame: both)
  floorGuide.update(position: position, at: time, frame: guidanceFrame(position, facing: guideFloor))
  stillGuide.update(position: .zero, at: time, frame: guidanceFrame(.zero, facing: guideRight))
  precondition(openGuide.cue == nil && floorGuide.cue == nil && stillGuide.cue == nil)
}
let sidedReplay = ReplaySource(script: replayScript)
sidedReplay.advance(to: 40)
precondition(sidedReplay.rescanSide == .right && sidedReplay.sectionNumber > 1)
sidedReplay.advance(to: 54)
precondition(sidedReplay.rescanSide == nil)
sidedReplay.advance(to: 76)
precondition(sidedReplay.tracking == .limited && sidedReplay.rescanSide == nil)
print("Side guidance passed direction, stationary recovery, open-side, floor-only and continuous-section checks.")

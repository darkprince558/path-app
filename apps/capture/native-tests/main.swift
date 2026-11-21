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
  hasVideo: false, partial: false, deviceModel: "synthetic wall fixture")
try JSONEncoder().encode(record).write(to: take.appendingPathComponent("scan.json"))
let captureID = UUID(uuidString: "b4ca8f7e-14a8-4fdc-9e54-0ea7936ff501")!
try CaptureBundle.write(
  take: take, record: record, captureID: captureID, to: dest.appendingPathComponent("capture"))
print("Exported the LiDAR bundle using the scanner writer.")

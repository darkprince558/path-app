import AppKit
import Foundation
import simd

// Export the same Swift geometry as the iPhone, with a measured 2 m wall and a floor triangle.
let dest = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
let bitmap = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: 64, pixelsHigh: 64, bitsPerSample: 8, samplesPerPixel: 3,
  hasAlpha: false, isPlanar:false, colorSpaceName: .deviceRGB, bytesPerRow: 192, bitsPerPixel: 24)!
let pixels = bitmap.bitmapData!
for y in 0..<64 {
  for x in 0..<64 {
    let i = y * bitmap.bytesPerRow + 3*x
    pixels[i] = x < 32 ? 235 : 24
    pixels[i+1] = y < 32 ? 40 : 205
    pixels[i+2] = x < 32 ? 28 : 224
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

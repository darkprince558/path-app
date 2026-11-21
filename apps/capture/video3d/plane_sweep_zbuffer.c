/* Nearest visible triangle depth at pixel centers in an undistorted camera. */
#include <math.h>

typedef struct { double x, y, z; } Point;

static void draw(const Point p[3], const double *k, int w, int h, int two_sided, float *depth) {
    double x[3], y[3], inv_z[3];
    for (int i = 0; i < 3; ++i) {
        inv_z[i] = 1.0 / p[i].z;
        x[i] = k[0] * p[i].x * inv_z[i] + k[2];
        y[i] = k[1] * p[i].y * inv_z[i] + k[3];
    }
    double det = (y[1]-y[2])*(x[0]-x[2]) + (x[2]-x[1])*(y[0]-y[2]);
    if (!isfinite(det) || fabs(det) < 1e-8 || (!two_sided && det >= 0)) return;
    double left = fmax(0, floor(fmin(x[0], fmin(x[1], x[2]))));
    double right = fmin(w-1, ceil(fmax(x[0], fmax(x[1], x[2]))));
    double top = fmax(0, floor(fmin(y[0], fmin(y[1], y[2]))));
    double bottom = fmin(h-1, ceil(fmax(y[0], fmax(y[1], y[2]))));
    if (left > right || top > bottom) return;

    for (int j = (int)top; j <= bottom; ++j) {
        for (int i = (int)left; i <= right; ++i) {
            double dx = i + 0.5 - x[2], dy = j + 0.5 - y[2];
            double a = ((y[1]-y[2])*dx + (x[2]-x[1])*dy) / det;
            double b = ((y[2]-y[0])*dx + (x[0]-x[2])*dy) / det;
            double c = 1.0 - a - b;
            if (a < 0 || b < 0 || c < 0) continue;
            float z = (float)(1.0 / (a*inv_z[0] + b*inv_z[1] + c*inv_z[2]));
            if (z < depth[j*w+i]) depth[j*w+i] = z;
        }
    }
}

void render_depth(const float *vertices, const int *faces, int face_count, const double *k,
                  int w, int h, int two_sided, double near_z, float *depth) {
    for (int t = 0; t < face_count; ++t) {
        Point p[3], polygon[4];
        for (int i = 0; i < 3; ++i) {
            const float *v = vertices + 3 * faces[3*t+i];
            p[i] = (Point){v[0], v[1], v[2]};
        }
        int count = 0;
        for (int i = 0; i < 3; ++i) {
            Point a = p[i], b = p[(i+1)%3];
            if (a.z >= near_z) polygon[count++] = a;
            if ((a.z >= near_z) != (b.z >= near_z)) {
                double ratio = (near_z-a.z) / (b.z-a.z);
                polygon[count++] = (Point){a.x+ratio*(b.x-a.x), a.y+ratio*(b.y-a.y), near_z};
            }
        }
        for (int i = 1; i + 1 < count; ++i) {
            Point triangle[3] = {polygon[0], polygon[i], polygon[i+1]};
            draw(triangle, k, w, h, two_sided, depth);
        }
    }
}

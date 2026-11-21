"""Camera ordering and RGB split shared by depth estimation, verification and texture baking."""


def ordered_poses(model):
    return sorted((image for image in model.images.values() if image.has_pose), key=lambda image: image.name)


def reserved_photo(index):
    return index % 5 == 2


def training_photo(index, observations, weak):
    return not reserved_photo(index) and observations >= 20 and not weak

function createMenuService({ menuRepo }) {
  async function listMenuItems(restaurantId) {
    return menuRepo.listMenuItems(restaurantId);
  }

  async function listAvailableMenuItems(restaurantId) {
    const items = await menuRepo.listMenuItems(restaurantId);
    return items.filter((item) => item.available);
  }

  return {
    listMenuItems,
    listAvailableMenuItems,
  };
}

module.exports = {
  createMenuService,
};

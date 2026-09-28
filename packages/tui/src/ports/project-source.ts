export interface ProjectRef {
  name: string;
  dir: string;
}

export interface ProjectSource {
  list(): ProjectRef[];
}

<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Brand extends Model
{
    use HasFactory;

    // The SQLite schema gave brands created_at only. Without this Eloquent
    // assumes $timestamps = true and writes an updated_at the table has no
    // column for.
    public $timestamps = false;

    protected $fillable = [
        'slug',
        'name',
        'color_primary',
        'color_secondary',
        'marker_icon',
        'logo_path',
        'sort_order',
    ];

    public function stations(): HasMany
    {
        return $this->hasMany(Station::class);
    }

    /**
     * Same camelCase shape the Node API returned, so public/js/icons.js,
     * legend.js and admin.js need no changes.
     */
    public function toApiArray(): array
    {
        return [
            'id' => $this->id,
            'slug' => $this->slug,
            'name' => $this->name,
            'colorPrimary' => $this->color_primary,
            'colorSecondary' => $this->color_secondary,
            'markerIcon' => $this->marker_icon,
            'logoPath' => $this->logo_path,
            'sortOrder' => $this->sort_order,
            'stationCount' => $this->stations()->count(),
        ];
    }
}
